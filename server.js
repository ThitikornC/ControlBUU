const http = require('http');
const mqtt = require('mqtt');
const { MongoClient } = require('mongodb');

// โหลด .env
require('dotenv').config();

// ===================== HTTP Health Check (Railway ต้องการ) =====================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  // Simple health and room-state endpoints. Allow CORS so front-end can fetch room state.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/room-state') {
    const payload = {
      success: true,
      roomState: roomState // mapping: { 'ห้อง101โถงชั้น1': 'ON', ... }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload, null, 2));
    return;
  }

  if (req.url === '/health' || req.url === '/') {
    const status = {
      status: 'running',
      mqtt: mqttClient ? (mqttClient.connected ? 'connected' : 'disconnected') : 'not initialized',
      db: db ? 'connected' : 'not connected',
      rooms: Object.entries(roomDesiredState).map(([r, s]) => `${r}: ${s} (actual: ${roomState[r] || '?'})`),
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
}).listen(PORT, () => {
  console.log(`🌐 Health check server listening on port ${PORT}`);
});

// ===================== CONFIG (จาก .env) =====================
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtts://mosquitto-broker-production-2037.up.railway.app';
const MQTT_OPTIONS = {
  port: parseInt(process.env.MQTT_PORT) || 8883,
  reconnectPeriod: 5000,
  connectTimeout: 30000,
};

// อนุญาตให้เปิดก่อนเวลา (นาที) ช่วง early allowance
const EARLY_ALLOWANCE_MIN = parseInt(process.env.EARLY_ALLOWANCE_MIN) || 15;

// ใส่ username/password ถ้ามี
if (process.env.MQTT_USERNAME) MQTT_OPTIONS.username = process.env.MQTT_USERNAME;
if (process.env.MQTT_PASSWORD) MQTT_OPTIONS.password = process.env.MQTT_PASSWORD;

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://nippit62:ohm0966477158@testing.hgxbz.mongodb.net/?retryWrites=true&w=majority';
const DB_NAME = process.env.DB_NAME || 'momay_buu';
const BOOKINGS_COLLECTION = process.env.BOOKINGS_COLLECTION || 'bookings';

// แมปห้องกับ Sonoff device (Tasmota topic)
// อ่านจาก .env: ROOM_DEVICE_MAP=ห้อง101=tasmota_room101,ห้อง202=tasmota_room202
function parseRoomDeviceMap() {
  const map = {};
  const envMap = process.env.ROOM_DEVICE_MAP || '';
  if (envMap) {
    envMap.split(',').forEach(pair => {
      const [room, device] = pair.trim().split('=');
      if (room && device) map[room] = device;
    });
  }
  return map;
}

const ROOM_DEVICE_MAP = parseRoomDeviceMap();

// ตรวจสอบทุกกี่วินาที
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 10000;

// ===================== STATE =====================
let db = null;
let mqttClient = null;

// เก็บสถานะที่ต้องการ (desired state) แยกจาก MQTT feedback
const roomDesiredState = {};
// เก็บสถานะจริงจาก MQTT feedback (สำหรับ log เท่านั้น)
const roomState = {};
// เก็บ timer สำหรับปิดอัตโนมัติ
const roomTimers = {};
// Cooldown: ป้องกันสั่ง ON/OFF ถี่เกินไป (มิลลิวินาที)
const COMMAND_COOLDOWN = 5000;
const lastCommandTime = {};

// ===================== MQTT =====================
function connectMQTT() {
  console.log('🔌 กำลังเชื่อมต่อ MQTT Broker...');
  console.log('   Broker:', MQTT_BROKER);

  mqttClient = mqtt.connect(MQTT_BROKER, MQTT_OPTIONS);

  mqttClient.on('connect', () => {
    console.log('✅ เชื่อมต่อ MQTT Broker สำเร็จ!');

    // Subscribe stat ของทุก device เพื่อดูสถานะ
    Object.values(ROOM_DEVICE_MAP).forEach(device => {
      mqttClient.subscribe(`stat/${device}/POWER`, (err) => {
        if (!err) {
          console.log(`   📡 Subscribe: stat/${device}/POWER`);
        }
      });
    });
  });

  mqttClient.on('message', (topic, message) => {
    const msg = message.toString();
    console.log(`📨 MQTT: ${topic} → ${msg}`);

    // อัปเดต state จาก Sonoff feedback
    Object.entries(ROOM_DEVICE_MAP).forEach(([room, device]) => {
      if (topic === `stat/${device}/POWER`) {
        roomState[room] = msg === 'ON' ? 'ON' : 'OFF';
        console.log(`   🏠 ${room} → ${roomState[room]}`);
      }
    });
  });

  mqttClient.on('error', (err) => {
    console.error('❌ MQTT Error:', err.message);
  });

  mqttClient.on('reconnect', () => {
    console.log('🔄 MQTT กำลังเชื่อมต่อใหม่...');
  });

  mqttClient.on('close', () => {
    console.log('🔌 MQTT Connection ปิด');
  });
}

// ส่งคำสั่งเปิด Sonoff
function turnOn(room) {
  const device = ROOM_DEVICE_MAP[room];
  if (!device) {
    console.log(`⚠️ ไม่พบ device สำหรับห้อง: ${room}`);
    return;
  }

  // ถ้า desired state เป็น ON อยู่แล้ว ไม่ต้องส่งซ้ำ
  if (roomDesiredState[room] === 'ON') {
    return;
  }

  // Cooldown: ป้องกันสั่งถี่เกินไป
  const now = Date.now();
  if (lastCommandTime[room] && (now - lastCommandTime[room]) < COMMAND_COOLDOWN) {
    return;
  }
  lastCommandTime[room] = now;
  roomDesiredState[room] = 'ON';

  const topic = `cmnd/${device}/Power`;
  mqttClient.publish(topic, 'ON', { qos: 1 }, (err) => {
    if (err) {
      console.error(`❌ ส่งคำสั่งเปิดล้มเหลว ${room}:`, err.message);
      roomDesiredState[room] = null; // reset เพื่อให้ลองใหม่
    } else {
      console.log(`🟢 เปิด ${room} (${device})`);
    }
  });
}

// ส่งคำสั่งปิด Sonoff
function turnOff(room) {
  const device = ROOM_DEVICE_MAP[room];
  if (!device) {
    console.log(`⚠️ ไม่พบ device สำหรับห้อง: ${room}`);
    return;
  }

  // ถ้า desired state เป็น OFF อยู่แล้ว ไม่ต้องส่งซ้ำ
  if (roomDesiredState[room] === 'OFF') {
    return;
  }

  // Cooldown: ป้องกันสั่งถี่เกินไป
  const now = Date.now();
  if (lastCommandTime[room] && (now - lastCommandTime[room]) < COMMAND_COOLDOWN) {
    return;
  }
  lastCommandTime[room] = now;
  roomDesiredState[room] = 'OFF';

  const topic = `cmnd/${device}/Power`;
  mqttClient.publish(topic, 'OFF', { qos: 1 }, (err) => {
    if (err) {
      console.error(`❌ ส่งคำสั่งปิดล้มเหลว ${room}:`, err.message);
      roomDesiredState[room] = null; // reset เพื่อให้ลองใหม่
    } else {
      console.log(`🔴 ปิด ${room} (${device})`);
    }
  });
}

// ===================== MONGODB =====================
async function connectDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
    console.log('✅ เชื่อมต่อ MongoDB สำเร็จ!');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    process.exit(1);
  }
}

// ===================== MAIN LOGIC =====================
async function checkBookings() {
  if (!db || !mqttClient || !mqttClient.connected) return;

  try {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const currentSecs = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

    // ดึง booking ของวันนี้ทุกห้อง
    const bookings = await db.collection(BOOKINGS_COLLECTION).find({
      date: today
    }).toArray();

    // เช็คทุกห้องที่มี device
    for (const [room, device] of Object.entries(ROOM_DEVICE_MAP)) {
      // หา booking ที่ active สำหรับห้องนี้
      const activeBooking = bookings.find(b => {
        // Strip ▼ suffix from room name (UI dropdown artifact)
        const bookingRoom = (b.room || '').replace(/\s*▼\s*/, '').trim();
        if (bookingRoom !== room) return false;
        const [startH, startM] = b.startTime.split(':').map(Number);
        const [endH, endM] = b.endTime.split(':').map(Number);
        const startSecs = startH * 3600 + startM * 60;
        const endSecs = endH * 3600 + endM * 60;
        const earlySecs = EARLY_ALLOWANCE_MIN * 60;
        return currentSecs >= (startSecs - earlySecs) && currentSecs <= endSecs;
      });

      if (activeBooking && activeBooking.firstCheckIn) {
        // ✅ มี booking + check-in แล้ว → เปิด
        turnOn(room);

        // คำนวณเวลาที่เหลือจนหมด booking ปัจจุบัน
        const [endH, endM] = activeBooking.endTime.split(':').map(Number);
        const endSecs = endH * 3600 + endM * 60;
        const remainingSecs = endSecs - currentSecs;

        // เคลียร์ timer เก่า (อาจเป็นของ booking ก่อนหน้า) แล้วตั้งใหม่เสมอ
        if (roomTimers[room]) {
          clearTimeout(roomTimers[room]);
          delete roomTimers[room];
        }

        if (remainingSecs > 0) {
          console.log(`⏱️ ตั้งเวลาปิด ${room} อีก ${Math.floor(remainingSecs / 60)} นาที ${remainingSecs % 60} วินาที`);
          roomTimers[room] = setTimeout(() => {
            console.log(`⏰ หมดเวลา! ปิด ${room}`);
            turnOff(room);
            delete roomTimers[room];
          }, remainingSecs * 1000);
        }
      } else if (!activeBooking) {
        // ❌ ไม่มี booking active → ปิด
        turnOff(room);

        // เคลียร์ timer ถ้ามี
        if (roomTimers[room]) {
          clearTimeout(roomTimers[room]);
          delete roomTimers[room];
        }
      }
      // ถ้ามี booking แต่ยังไม่ check-in → ไม่ทำอะไร (ยังไม่เปิด)
    }
  } catch (err) {
    console.error('❌ Error checking bookings:', err.message);
  }
}

// ===================== START =====================
async function start() {
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  🏠 Sonoff Tasmota Controller');
  console.log('  📡 MQTT + MongoDB Booking System');
  console.log('═══════════════════════════════════════════');
  console.log('');

  // 1. เชื่อมต่อ MongoDB
  await connectDB();

  // 2. เชื่อมต่อ MQTT
  connectMQTT();

  // 3. รอ MQTT เชื่อมต่อเสร็จ แล้วเริ่ม loop
  mqttClient.on('connect', () => {
    // เช็คทันทีครั้งแรก
    checkBookings();

    // เช็คทุก 10 วินาที
    setInterval(checkBookings, CHECK_INTERVAL);
  });

  console.log('');
  console.log('📋 Room-Device Map:');
  Object.entries(ROOM_DEVICE_MAP).forEach(([room, device]) => {
    console.log(`   ${room} → ${device}`);
  });
  console.log('');
  console.log(`🔄 ตรวจสอบทุก ${CHECK_INTERVAL / 1000} วินาที`);
  console.log('');
  console.log('Logic:');
  console.log('  ✅ Check-in (firstCheckIn มีค่า) → เปิด Sonoff');
  console.log('  ⏰ หมดเวลา (endTime) → ปิด Sonoff');
  console.log('  ❌ ไม่มี booking → ปิด Sonoff');
  console.log('');
}

start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
