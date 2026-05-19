-- ================================================================
-- LOCO TM CMS - RUT200 Script v11.0 FINAL
-- Himnish Limited
-- Fix: JSON saved to file before curl push (no escape issues)
-- ================================================================

os.execute("mkdir -p /etc/mosquitto")
os.execute("echo 'listener 1883 0.0.0.0' > /etc/mosquitto/mosquitto.conf")
os.execute("echo 'allow_anonymous true' >> /etc/mosquitto/mosquitto.conf")
os.execute("killall mosquitto 2>/dev/null; sleep 1")
os.execute("mosquitto -d -c /etc/mosquitto/mosquitto.conf")
os.execute("sleep 3")

local socket = require("socket")

local RAILWAY  = "https://loco-tm-cms-production.up.railway.app/api/data/ingest"
local API_KEY  = "himnish_data_key_2024"
local LOCO_IP  = "192.168.1.1"
local SERIAL   = "HU00945596900021"
local INTERVAL = 5  -- push every 5 seconds

local PORT_MAP = {
  ["master1port1"]="TM1",["master1port2"]="TM2",["master1port3"]="TM3",
  ["master1port4"]="TM4",["master1port5"]="TM5",["master1port6"]="TM6",
}

-- Float32 Big Endian
local function f32(b1,b2,b3,b4)
  local sign=b1>=128 and -1 or 1
  local exp=((b1%128)*2)+math.floor(b2/128)-127
  local mant=((b2%128)*65536)+(b3*256)+b4
  if exp==-127 then return sign*math.ldexp(mant,-149)
  else return sign*math.ldexp(mant+8388608,exp-23) end
end

local function rnd(n,d) local m=10^(d or 3); return math.floor(n*m+0.5)/m end

-- Parse BCM0003
local function parse_bytes(bs_str)
  local b={}
  for n in bs_str:gmatch("%d+") do b[#b+1]=tonumber(n) end
  if #b<28 then return nil end
  local vx=f32(b[1],b[2],b[3],b[4])
  local vy=f32(b[5],b[6],b[7],b[8])
  local vz=f32(b[9],b[10],b[11],b[12])
  local rms=f32(b[13],b[14],b[15],b[16])
  local peak=f32(b[21],b[22],b[23],b[24])
  local temp=f32(b[25],b[26],b[27],b[28])
  local crest=rms>0 and peak/rms or 0
  return {
    vib={x=rnd(vx,4),y=rnd(vy,4),z=rnd(vz,4),
         rms=rnd(rms,4),peak=rnd(peak,4),
         crestFactor=rnd(crest,2),freq=0},
    temp=rnd(temp,1),ioLinkStatus="OK"
  }
end

-- MQTT Connect
local function mqtt_connect()
  local c=socket.tcp(); c:settimeout(5)
  local ok,err=c:connect("127.0.0.1",1883)
  if not ok then print("TCP:"..tostring(err)); return nil end
  local cid="rut_"..tostring(os.time())
  local pl=string.char(0,4,77,81,84,84,4,2,0,60,0,#cid)..cid
  c:send(string.char(0x10,#pl)..pl)
  socket.sleep(0.5)
  local ack=c:receive(4)
  if not ack or ack:byte(1)~=0x20 then
    print("No CONNACK"); c:close(); return nil
  end
  print("MQTT OK!")
  return c
end

local function mqtt_sub(c,t)
  c:send(string.char(0x82,#t+5,0,1,0,#t)..t..string.char(0))
end

-- Build JSON
local function build_json(tm_data)
  local ts=os.date("!%Y-%m-%dT%H:%M:%SZ")
  local j='{"locoIp":"'..LOCO_IP..'","timestamp":"'..ts..'","tmData":{'
  local f=true
  for tm,d in pairs(tm_data) do
    if not f then j=j.."," end
    j=j..'"'..tm..'":{"vib":{"x":'..d.vib.x..',"y":'..d.vib.y..',"z":'..d.vib.z
    j=j..',"rms":'..d.vib.rms..',"peak":'..d.vib.peak
    j=j..',"crestFactor":'..d.vib.crestFactor..',"freq":0}'
    j=j..',"temp":'..d.temp..',"ioLinkStatus":"OK"}'
    f=false
  end
  return j.."}}"
end

-- Push using curl with JSON file (avoids shell escaping issues)
local function push(tm_data)
  local json=build_json(tm_data)
  -- Write JSON to temp file
  local f=io.open("/tmp/push_data.json","w")
  if not f then print("Cannot write JSON file"); return end
  f:write(json); f:close()
  -- Push using curl with file
  local cmd='curl -sk -X POST'
  cmd=cmd..' -H "Content-Type: application/json"'
  cmd=cmd..' -H "x-api-key: '..API_KEY..'"'
  cmd=cmd..' -d @/tmp/push_data.json'
  cmd=cmd..' '..RAILWAY
  cmd=cmd..' -o /tmp/push_resp.txt'
  os.execute(cmd)
  -- Read response
  local rf=io.open("/tmp/push_resp.txt","r")
  if rf then
    local resp=rf:read("*a"); rf:close()
    if resp and resp:find("success") then
      io.write("[OK] "); io.flush()
    else
      io.write("[ERR:"..tostring(resp).."] "); io.flush()
    end
  end
end

-- Process buffer
local function process_buffer(buf, tm_data)
  local pos=1
  while true do
    local bs,be=buf:find('"bytes"%s*:%s*%[',pos)
    if not bs then break end
    local ae=buf:find('%]',be)
    if not ae then break end
    local bytes_str=buf:sub(be+1,ae-1)
    local lookback=buf:sub(math.max(1,bs-200),bs)
    for port,tm in pairs(PORT_MAP) do
      if lookback:find(port,1,true) then
        local sensor=parse_bytes(bytes_str)
        if sensor then
          tm_data[tm]=sensor
        end
        break
      end
    end
    pos=ae+1
  end
end

-- MAIN
print("LOCO TM CMS v11.0 | Himnish Limited")
print("Server: "..RAILWAY)
print("Push interval: "..INTERVAL.."s")
local tm_data={}
local last_push=os.time()
local buf_acc=""

while true do
  local c=mqtt_connect()
  if not c then
    os.execute("mosquitto -d -c /etc/mosquitto/mosquitto.conf 2>/dev/null")
    socket.sleep(5)
  else
    for port,_ in pairs(PORT_MAP) do
      local t="balluff/"..SERIAL.."/iolink/devices/"..port.."/databytes/fromdevice"
      mqtt_sub(c,t)
    end
    socket.sleep(0.5)
    print("Subscribed! Listening...")
    c:settimeout(2)
    buf_acc=""

    while true do
      local chunk,err=c:receive(1024)
      if chunk then
        buf_acc=buf_acc..chunk
        process_buffer(buf_acc,tm_data)
        if #buf_acc>4000 then buf_acc=buf_acc:sub(-2000) end
      elseif err~="timeout" then
        print("\nDisconnected:"..tostring(err))
        c:close()
        os.execute("mosquitto -d -c /etc/mosquitto/mosquitto.conf 2>/dev/null")
        socket.sleep(3)
        break
      end

      -- Push every INTERVAL seconds
      local now=os.time()
      if now-last_push>=INTERVAL and next(tm_data) then
        push(tm_data)
        last_push=now
      end
    end
  end
end
