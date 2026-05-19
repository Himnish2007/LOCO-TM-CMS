-- ============================================================
-- LOCO TM CMS — RUT200 Data Push Script
-- Himnish Limited
-- Hardware: RUT200 + Balluff BNI00L1 (192.168.1.25)
-- Server: https://loco-tm-cms-production.up.railway.app
-- ============================================================

local http = require("socket.http")
local ltn12 = require("ltn12")
local json = require("json")

-- ============================================================
-- CONFIGURATION
-- ============================================================
local SERVER_URL     = "https://loco-tm-cms-production.up.railway.app/api/data/ingest"
local API_KEY        = "himnish_data_key_2024"
local LOCO_IP        = "192.168.1.1"
local PUSH_INTERVAL  = 60   -- seconds (1 minute)

-- Balluff BNI00L1 — Modbus TCP
local BNI_IP         = "192.168.1.25"
local BNI_PORT       = 502

-- Balluff BCM0002 — set karo jab IP mile
local BCM_IP         = "192.168.1.21"   -- CHANGE THIS
local BCM_PORT       = 502

-- ============================================================
-- MODBUS TCP READ FUNCTION
-- ============================================================
local socket = require("socket")

local function modbus_read(ip, port, reg, count)
    count = count or 1
    local s = socket.tcp()
    s:settimeout(3)
    local ok, err = s:connect(ip, port)
    if not ok then
        s:close()
        return nil, "connect error: " .. tostring(err)
    end

    -- Modbus TCP Request: Read Holding Registers (FC=03)
    -- Transaction(2) + Protocol(2) + Length(2) + Unit(1) + FC(1) + Reg(2) + Count(2)
    local tid_hi, tid_lo = 0, 1
    local reg_hi  = math.floor(reg / 256)
    local reg_lo  = reg % 256
    local cnt_hi  = math.floor(count / 256)
    local cnt_lo  = count % 256
    local request = string.char(
        tid_hi, tid_lo,   -- Transaction ID
        0, 0,             -- Protocol ID
        0, 6,             -- Length
        1,                -- Unit ID
        3,                -- Function Code: Read Holding Registers
        reg_hi, reg_lo,   -- Start Register
        cnt_hi, cnt_lo    -- Register Count
    )

    s:send(request)
    local response, err2 = s:receive(9 + count * 2)
    s:close()

    if not response then
        return nil, "receive error: " .. tostring(err2)
    end

    -- Parse response: byte 9 onwards = data
    local values = {}
    for i = 1, count do
        local hi = string.byte(response, 9 + (i-1)*2)
        local lo = string.byte(response, 10 + (i-1)*2)
        local val = hi * 256 + lo
        -- Convert to signed INT16
        if val > 32767 then val = val - 65536 end
        table.insert(values, val)
    end
    return values
end

-- ============================================================
-- COLLECT ALL 6 TM DATA
-- BNI00L1 Modbus Register Map:
--   TM1: VibX=0, VibY=1, VibZ=2, Temp=3
--   TM2: VibX=4, VibY=5, VibZ=6, Temp=7
--   TM3: VibX=8, VibY=9, VibZ=10, Temp=11
--   TM4: VibX=12, VibY=13, VibZ=14, Temp=15
--   TM5: VibX=16, VibY=17, VibZ=18, Temp=19
--   TM6: VibX=20, VibY=21, VibZ=22, Temp=23
--   Scale: Vib = reg/1000 (m/s²), Temp = reg/10 (°C)
-- ============================================================
local function collect_data()
    local tm_data = {}

    -- Read all 24 registers in one shot (faster)
    local regs, err = modbus_read(BNI_IP, BNI_PORT, 0, 24)

    if not regs then
        print("[WARN] BNI00L1 read failed: " .. tostring(err))
        -- Return simulated data as fallback
        for i = 1, 6 do
            local base = 1.2 + math.random() * 2
            tm_data["TM" .. i] = {
                vib = {
                    x    = math.floor((base + (math.random()-0.5)*0.5) * 10000) / 10000,
                    y    = math.floor((base + (math.random()-0.5)*0.5) * 10000) / 10000,
                    z    = math.floor((base * 0.8 + (math.random()-0.5)*0.3) * 10000) / 10000,
                    rms  = math.floor((base + math.random()*0.3) * 10000) / 10000,
                    peak = math.floor((base * 1.8 + math.random()) * 10000) / 10000,
                    crestFactor = math.floor((3 + math.random()*2) * 100) / 100,
                    freq = math.floor((50 + math.random()*100) * 10) / 10
                },
                temp         = math.floor((45 + math.random()*25) * 10) / 10,
                ioLinkStatus = "SIMULATED"
            }
        end
        return tm_data
    end

    for i = 1, 6 do
        local base = (i - 1) * 4
        local vib_x = regs[base + 1] / 1000.0
        local vib_y = regs[base + 2] / 1000.0
        local vib_z = regs[base + 3] / 1000.0
        local temp  = regs[base + 4] / 10.0

        local vib_rms   = math.sqrt((vib_x^2 + vib_y^2 + vib_z^2) / 3)
        local vib_peak  = math.max(math.abs(vib_x), math.abs(vib_y), math.abs(vib_z))
        local crest_fac = vib_rms > 0 and (vib_peak / vib_rms) or 0

        tm_data["TM" .. i] = {
            vib = {
                x           = math.floor(vib_x * 10000) / 10000,
                y           = math.floor(vib_y * 10000) / 10000,
                z           = math.floor(vib_z * 10000) / 10000,
                rms         = math.floor(vib_rms * 10000) / 10000,
                peak        = math.floor(vib_peak * 10000) / 10000,
                crestFactor = math.floor(crest_fac * 100) / 100,
                freq        = 0
            },
            temp         = math.floor(temp * 10) / 10,
            ioLinkStatus = "OK"
        }
    end

    return tm_data
end

-- ============================================================
-- PUSH TO CLOUD SERVER
-- ============================================================
local function push_data(tm_data)
    local timestamp = os.date("!%Y-%m-%dT%H:%M:%SZ")
    local payload = json.encode({
        locoIp    = LOCO_IP,
        tmData    = tm_data,
        timestamp = timestamp
    })

    local resp = {}
    local res, code = http.request({
        url     = SERVER_URL,
        method  = "POST",
        headers = {
            ["Content-Type"]   = "application/json",
            ["Content-Length"] = tostring(#payload),
            ["x-api-key"]      = API_KEY
        },
        source = ltn12.source.string(payload),
        sink   = ltn12.sink.table(resp)
    })

    if code == 200 then
        print("[" .. timestamp .. "] ✓ Data pushed OK — " .. #tm_data .. " TMs")
    else
        print("[" .. timestamp .. "] ✗ Push failed: HTTP " .. tostring(code))
    end
end

-- ============================================================
-- MAIN LOOP
-- ============================================================
math.randomseed(os.time())
print("================================================")
print("  LOCO TM CMS — RUT200 Push Script")
print("  Server : " .. SERVER_URL)
print("  BNI IP : " .. BNI_IP)
print("  BCM IP : " .. BCM_IP)
print("  Interval: " .. PUSH_INTERVAL .. "s")
print("================================================")

while true do
    local ok, err = pcall(function()
        local tm_data = collect_data()
        push_data(tm_data)
    end)
    if not ok then
        print("[ERROR] " .. tostring(err))
    end
    os.execute("sleep " .. PUSH_INTERVAL)
end
