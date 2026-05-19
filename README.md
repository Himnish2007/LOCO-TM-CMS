# LOCO TM CONDITION MONITORING SYSTEM
## Himnish Limited — Traction Motor Predictive Analytics

### Live URL
https://loco-tm-cms-production.up.railway.app

### Login
- Username: admin
- Password: Himnish@2024

### Hardware Setup
- RUT200 Router: 192.168.1.1
- BNI XG1-505-0A5-R067 (BNI00L1): 192.168.1.10
- BCM0003 IO-Link Sensors: Port 1-6 (TM1-TM6)

### Project Structure
```
CMS/
├── backend/
│   └── server.js          ← Node.js backend (Railway deployed)
├── frontend/
│   └── public/
│       └── index.html     ← Dashboard (light professional theme)
├── rut200/
│   ├── loco_push_v13.lua  ← LATEST RUT200 script (use this!)
│   └── loco_push.lua      ← Previous version
├── package.json
├── railway.json
└── .gitignore
```

### Railway Variables
```
JWT_SECRET     = HimnishTMCMS2024SecretKey
DATA_API_KEY   = himnish_data_key_2024
DEMO_MODE      = false
```

### RUT200 Setup (kal subah)
1. SCP script: scp rut200/loco_push_v13.lua root@192.168.1.1:/tmp/loco_push.lua
2. CLI: mosquitto -d -c /etc/mosquitto/mosquitto.conf && sleep 2 && lua /tmp/loco_push.lua
3. Custom Scripts mein paste karo for auto-start on reboot

### BNI00L1 MQTT Settings
- Broker URL: 192.168.1.1
- Port: 1883
- Client ID: bni_HU00945596900021
- Topic: balluff/HU00945596900021/iolink/devices/master1portX/databytes/fromdevice

### GitHub
https://github.com/Himnish2007/LOCO-TM-CMS.git

### Contact
F-408, Aditya Corporate Hub, RDC, Rajnagar, Ghaziabad, UP – 201001
+91-9873909306 / +91-120-4156671
piyush@himnishindia.com | himnishprojects.com
