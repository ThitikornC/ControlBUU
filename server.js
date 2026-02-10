const mqtt = require('mqtt');
const { MongoClient } = require('mongodb');

// โหลด .env
require('dotenv').config();

// ===================== CONFIG (จาก .env) =====================
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtts://mosquitto-broker-production-2037.up.railway.app';
const MQTT_OPTIONS = {
  port: parseInt(process.env.MQTT_PORT) || 8883,
  reconnectPeriod: 5000,
  connectTimeout: 30000,
};

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

// เก็บสถานะ: ห้องไหนเปิดอยู่ เพื่อไม่ส่งซ้ำ
const roomState = {};
// เก็บ timer สำหรับปิดอัตโนมัติ
const roomTimers = {};

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

  if (roomState[room] === 'ON') {
    return; // เปิดอยู่แล้ว ไม่ต้องส่งซ้ำ
  }

  const topic = `cmnd/${device}/Power`;
  mqttClient.publish(topic, 'ON', { qos: 1 }, (err) => {
    if (err) {
      console.error(`❌ ส่งคำสั่งเปิดล้มเหลว ${room}:`, err.message);
    } else {
      console.log(`🟢 เปิด ${room} (${device})`);
      roomState[room] = 'ON';
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

  if (roomState[room] === 'OFF') {
    return; // ปิดอยู่แล้ว ไม่ต้องส่งซ้ำ
  }

  const topic = `cmnd/${device}/Power`;
  mqttClient.publish(topic, 'OFF', { qos: 1 }, (err) => {
    if (err) {
      console.error(`❌ ส่งคำสั่งปิดล้มเหลว ${room}:`, err.message);
    } else {
      console.log(`🔴 ปิด ${room} (${device})`);
      roomState[room] = 'OFF';
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
        if (b.room !== room) return false;
        const [startH, startM] = b.startTime.split(':').map(Number);
        const [endH, endM] = b.endTime.split(':').map(Number);
        const startSecs = startH * 3600 + startM * 60;
        const endSecs = endH * 3600 + endM * 60;
        return currentSecs >= startSecs && currentSecs <= endSecs;
      });

      if (activeBooking && activeBooking.firstCheckIn) {
        // ✅ มี booking + check-in แล้ว → เปิด
        turnOn(room);

        // ตั้ง timer ปิดอัตโนมัติเมื่อหมดเวลา
        const [endH, endM] = activeBooking.endTime.split(':').map(Number);
        const endSecs = endH * 3600 + endM * 60;
        const remainingSecs = endSecs - currentSecs;

        if (remainingSecs > 0 && !roomTimers[room]) {
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
