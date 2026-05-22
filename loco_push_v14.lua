-- ================================================================
-- LOCO TM CMS - RUT200 Script v14.0 FINAL
-- Himnish Limited
-- Auto-installs mosquitto + isValid sensor detection
-- ================================================================

os.execute("which mosquitto || opkg update && opkg install mosquitto-ssl 2>/dev/null")
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
local INTERVAL = 2
local SENSOR_TIMEOUT = 15 -- seconds without data = sensor disconnected

local PORT_MAP = {
  ["master1port1"]="TM1",["master1port2"]="TM2",["master1port3"]="TM3",
  ["master1port4"]="TM4",["master1port5"]="TM5",["master1port6"]="TM6",
}

local function f32(b1,b2,b3,b4)
  local sign=b1>=128 and -1 or 1
  local exp=math.floor((b1%128)*2+math.floor(b2/128))-127
  local mant=math.floor((b2%128)*65536+b3*256+b4)
  if exp==-127 then return sign*math.ldexp(mant,-149)
  else return sign*math.ldexp(mant+8388608,exp-23) end
end

local function rnd(n,d) local m=10^(d or 3); return math.floor(n*m+0.5)/m end

local function parse_sensor(json_chunk)
  local isValid = json_chunk:match('"isValid"%s*:%s*(%a+)')
  if isValid == "false" then return nil, "disconnected" end
  local bs = json_chunk:match('"bytes"%s*:%s*%[([%d,]+)%]')
  if not bs then return nil, "no bytes" end
  local b={}
  for n in bs:gmatch("%d+") do b[#b+1]=tonumber(n) end
  if #b<28 then return nil, "short" end
  local ok1,vx=pcall(f32,b[1],b[2],b[3],b[4]); if not ok1 then return nil,"err" end
  local _,vy=pcall(f32,b[5],b[6],b[7],b[8])
  local _,vz=pcall(f32,b[9],b[10],b[11],b[12])
  local _,rms=pcall(f32,b[13],b[14],b[15],b[16])
  local _,peak=pcall(f32,b[21],b[22],b[23],b[24])
  local _,temp=pcall(f32,b[25],b[26],b[27],b[28])
  vx=vx or 0; vy=vy or 0; vz=vz or 0
  rms=rms or 0; peak=peak or 0; temp=temp or 0
  return {
    vib={x=rnd(vx,4),y=rnd(vy,4),z=rnd(vz,4),
         rms=rnd(rms,4),peak=rnd(peak,4),
         crestFactor=rms>0 and rnd(peak/rms,2) or 0,freq=0},
    temp=rnd(temp,1),ioLinkStatus="OK"
  }, "ok"
end

local function mqtt_connect()
  local c=socket.tcp(); c:settimeout(5)
  local ok,err=c:connect("127.0.0.1",1883)
  if not ok then print("TCP:"..tostring(err)); return nil end
  local cid="rut_"..tostring(os.time())
  local pl=string.char(0,4,77,81,84,84,4,2,0,60,0,#cid)..cid
  c:send(string.char(0x10,#pl)..pl)
  socket.sleep(0.5)
  local ack=c:receive(4)
  if not ack or ack:byte(1)~=0x20 then print("No CONNACK"); c:close(); return nil end
  print("MQTT OK!")
  return c
end

local function mqtt_sub(c,t)
  c:send(string.char(0x82,#t+5,0,1,0,#t)..t..string.char(0))
end

local function build_json(tm_data)
  local ts=os.date("!%Y-%m-%dT%H:%M:%SZ")
  local j='{"locoIp":"'..LOCO_IP..'","timestamp":"'..ts..'","tmData":{'
  local f=true
  for tm,d in pairs(tm_data) do
    if not f then j=j.."," end
    j=j..'"'..tm..'":{"vib":{"x":'..d.vib.x..',"y":'..d.vib.y..',"z":'..d.vib.z
    j=j..',"rms":'..d.vib.rms..',"peak":'..d.vib.peak
    j=j..',"crestFactor":'..d.vib.crestFactor..',"freq":0}'
    j=j..',"temp":'..d.temp..',"ioLinkStatus":"'..d.ioLinkStatus..'"}'
    f=false
  end
  return j.."}}"
end

local function push(tm_data)
  if not next(tm_data) then return end
  local json=build_json(tm_data)
  local fh=io.open("/tmp/push_data.json","w")
  if not fh then return end
  fh:write(json); fh:close()
  os.execute('curl -sk -X POST -H "Content-Type: application/json" -H "x-api-key: '..API_KEY..'" -d @/tmp/push_data.json '..RAILWAY..' -o /tmp/push_resp.txt 2>/dev/null')
  local rf=io.open("/tmp/push_resp.txt","r")
  if rf then
    local resp=rf:read("*a"); rf:close()
    io.write(resp:find("success") and "[OK] " or "[ERR] "); io.flush()
  end
end

local function process_buffer(buf, tm_data, last_seen)
  local pos=1
  while true do
    local js=buf:find('{"timestamp"',pos,true)
    if not js then break end
    local je=buf:find('}}',js,true)
    if not je then break end
    local chunk=buf:sub(js,je+1)
    local lookback=buf:sub(math.max(1,js-200),js)
    for port,tm in pairs(PORT_MAP) do
      if lookback:find(port,1,true) then
        local sensor,reason=parse_sensor(chunk)
        if sensor then
          tm_data[tm]=sensor
          last_seen[tm]=os.time()
          io.write(tm.."("..sensor.temp.."C "..sensor.vib.rms..") "); io.flush()
        elseif reason=="disconnected" then
          tm_data[tm]={vib={x=0,y=0,z=0,rms=0,peak=0,crestFactor=0,freq=0},temp=0,ioLinkStatus="DISCONNECTED"}
          io.write(tm.."[NC] "); io.flush()
        end
        break
      end
    end
    pos=je+2
  end
end

-- MAIN
print("LOCO TM CMS v14.0 | Himnish Limited")
print("Server: "..RAILWAY)
local tm_data={} local last_push=os.time() local buf_acc=""
local last_seen={} -- track last valid data time per TM

while true do
  local c=mqtt_connect()
  if not c then
    os.execute("mosquitto -d -c /etc/mosquitto/mosquitto.conf 2>/dev/null")
    socket.sleep(5)
  else
    for port,_ in pairs(PORT_MAP) do
      mqtt_sub(c,"balluff/"..SERIAL.."/iolink/devices/"..port.."/databytes/fromdevice")
    end
    socket.sleep(0.5)
    print("Subscribed! Listening...")
    c:settimeout(2); buf_acc=""
    while true do
      local chunk,err=c:receive(1024)
      if chunk then
        buf_acc=buf_acc..chunk
        process_buffer(buf_acc,tm_data,last_seen)
        if #buf_acc>4000 then buf_acc=buf_acc:sub(-2000) end
      elseif err~="timeout" then
        print("\nDisconnected:"..tostring(err))
        c:close()
        os.execute("mosquitto -d -c /etc/mosquitto/mosquitto.conf 2>/dev/null")
        socket.sleep(3); break
      end
      local now=os.time()
      -- Timeout check: if sensor was seen but stopped sending, mark DISCONNECTED
      for port,tm in pairs(PORT_MAP) do
        if last_seen[tm] ~= nil and (now - last_seen[tm]) > SENSOR_TIMEOUT then
          tm_data[tm]={vib={x=0,y=0,z=0,rms=0,peak=0,crestFactor=0,freq=0},
                       temp=0,ioLinkStatus="DISCONNECTED"}
          last_seen[tm]=nil
          io.write(tm.."[TO] "); io.flush()
        end
      end
      if now-last_push>=INTERVAL and next(tm_data) then
        push(tm_data); last_push=now
      end
    end
  end
end
