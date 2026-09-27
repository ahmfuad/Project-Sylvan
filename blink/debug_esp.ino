#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

#include "esp_camera.h"
#include "img_converters.h"
#include "mbedtls/base64.h"

// =====================================================
// DEBUG SKETCH — camera capture + OpenAI tree/object check ONLY.
//
// No ATmega UART, no server upload, no live stream, no web portal — just:
//   capture a photo -> send it to OpenAI -> print exactly what came back.
//
// Use this to isolate why the real sketch shows "No result" / "failed":
// every step below prints enough detail to tell you exactly which one broke.
// =====================================================


// ---- EDIT THESE TWO for your setup (same as sylvan_esp32cam.ino) ----
const char *WIFI_SSID = "Rayhan";
const char *WIFI_PASSWORD = "qqqqqqqq";
// -----------------------------------------------------------------------

// ---- PASTE YOUR OWN OPENAI KEY HERE. Do not commit it. ----
const char *OPENAI_API_KEY = "sk-PASTE_YOUR_KEY_HERE";
// -------------------------------------------------------------

const char *OPENAI_HOST = "api.openai.com";
const char *OPENAI_PATH = "/v1/chat/completions";
const char *OPENAI_MODEL = "gpt-5.5";
const char *OPENAI_PROMPT =
    "Photo from a small rover in a rooftop garden. Reply with exactly one word: "
    "TREE if the main object is a plant or small tree in a tub, pot or planter; "
    "otherwise OBJECT.";

const unsigned long CAPTURE_INTERVAL_MS = 15000;   // repeat every 15 s; also 'c'+Enter to force one

// api.openai.com chains to GTS Root R4, cross-signed by GlobalSign Root CA. Both trusted.
const char *ROOT_CA_OPENAI PROGMEM = R"CERT(
-----BEGIN CERTIFICATE-----
MIICCTCCAY6gAwIBAgINAgPlwGjvYxqccpBQUjAKBggqhkjOPQQDAzBHMQswCQYD
VQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIG
A1UEAxMLR1RTIFJvb3QgUjQwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAw
WjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2Vz
IExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQwdjAQBgcqhkjOPQIBBgUrgQQAIgNi
AATzdHOnaItgrkO4NcWBMHtLSZ37wWHO5t5GvWvVYRg1rkDdc/eJkTBa6zzuhXyi
QHY7qca4R9gq55KRanPpsXI5nymfopjTX15YhmUPoYRlBtHci8nHc8iMai/lxKvR
HYqjQjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQW
BBSATNbrdP9JNqPV2Py1PsVq8JQdjDAKBggqhkjOPQQDAwNpADBmAjEA6ED/g94D
9J+uHXqnLrmvT/aDHQ4thQEd0dlq7A/Cr8deVl5c1RxYIigL9zC2L7F8AjEA8GE8
p/SgguMh1YQdc4acLa/KNJvxn7kjNuK8YAOdgLOaVsjh4rsUecrNIdSUtUlD
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIDdTCCAl2gAwIBAgILBAAAAAABFUtaw5QwDQYJKoZIhvcNAQEFBQAwVzELMAkG
A1UEBhMCQkUxGTAXBgNVBAoTEEdsb2JhbFNpZ24gbnYtc2ExEDAOBgNVBAsTB1Jv
b3QgQ0ExGzAZBgNVBAMTEkdsb2JhbFNpZ24gUm9vdCBDQTAeFw05ODA5MDExMjAw
MDBaFw0yODAxMjgxMjAwMDBaMFcxCzAJBgNVBAYTAkJFMRkwFwYDVQQKExBHbG9i
YWxTaWduIG52LXNhMRAwDgYDVQQLEwdSb290IENBMRswGQYDVQQDExJHbG9iYWxT
aWduIFJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDaDuaZ
jc6j40+Kfvvxi4Mla+pIH/EqsLmVEQS98GPR4mdmzxzdzxtIK+6NiY6arymAZavp
xy0Sy6scTHAHoT0KMM0VjU/43dSMUBUc71DuxC73/OlS8pF94G3VNTCOXkNz8kHp
1Wrjsok6Vjk4bwY8iGlbKk3Fp1S4bInMm/k8yuX9ifUSPJJ4ltbcdG6TRGHRjcdG
snUOhugZitVtbNV4FpWi6cgKOOvyJBNPc1STE4U6G7weNLWLBYy5d4ux2x8gkasJ
U26Qzns3dLlwR5EiUWMWea6xrkEmCMgZK9FGqkjWZCrXgzT/LCrBbBlDSgeF59N8
9iFo7+ryUp9/k5DPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8E
BTADAQH/MB0GA1UdDgQWBBRge2YaRQ2XyolQL30EzTSo//z9SzANBgkqhkiG9w0B
AQUFAAOCAQEA1nPnfE920I2/7LqivjTFKDK1fPxsnCwrvQmeU79rXqoRSLblCKOz
yj1hTdNGCbM+w6DjY1Ub8rrvrTnhQ7k4o+YviiY776BQVvnGCv04zcQLcFGUl5gE
38NflNUVyRRBnMRddWQVDf9VMOyGj/8N7yy5Y0b2qvzfvGn9LhJIZJrglfCm7ymP
AbEVtQwdpf5pLGkkeB6zpxxxYu7KyJesF12KwvhHhm4qxFYxldBniYUr+WymXUad
DKqC5JlR3XC321Y9YeRq4VzW9v493kHMB65jUr9TU/Qr6cf9tveCX4XSQRjbgbME
HMUfpIBvFSDJ3gyICh3WZlXi/EjJKSZp4A==
-----END CERTIFICATE-----
)CERT";


// =====================================================
// CAMERA PINOUT (AI-Thinker compatible, RBD-1407) — same as sylvan_esp32cam.ino
// =====================================================

#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

bool cameraReady = false;


// =====================================================
// CAMERA INIT
// =====================================================

bool initCamera()
{
    camera_config_t config = {};

    config.ledc_channel = LEDC_CHANNEL_0;
    config.ledc_timer   = LEDC_TIMER_0;

    config.pin_d0 = Y2_GPIO_NUM;
    config.pin_d1 = Y3_GPIO_NUM;
    config.pin_d2 = Y4_GPIO_NUM;
    config.pin_d3 = Y5_GPIO_NUM;
    config.pin_d4 = Y6_GPIO_NUM;
    config.pin_d5 = Y7_GPIO_NUM;
    config.pin_d6 = Y8_GPIO_NUM;
    config.pin_d7 = Y9_GPIO_NUM;

    config.pin_xclk  = XCLK_GPIO_NUM;
    config.pin_pclk  = PCLK_GPIO_NUM;
    config.pin_vsync = VSYNC_GPIO_NUM;
    config.pin_href  = HREF_GPIO_NUM;

    config.pin_sccb_sda = SIOD_GPIO_NUM;
    config.pin_sccb_scl = SIOC_GPIO_NUM;

    config.pin_pwdn  = PWDN_GPIO_NUM;
    config.pin_reset = RESET_GPIO_NUM;

    config.xclk_freq_hz = 20000000;
    config.pixel_format = PIXFORMAT_RGB565;   // GC2145 has no hardware JPEG encoder
    config.fb_count = 1;

    if (psramFound())
    {
        Serial.println("PSRAM: FOUND");
        config.frame_size  = FRAMESIZE_QVGA;      // 320 x 240
        config.fb_location = CAMERA_FB_IN_PSRAM;
    }
    else
    {
        Serial.println("PSRAM: NOT FOUND (enable Tools > PSRAM)");
        config.frame_size  = FRAMESIZE_QQVGA;     // 160 x 120
        config.fb_location = CAMERA_FB_IN_DRAM;
    }

    config.grab_mode = CAMERA_GRAB_LATEST;

    esp_err_t err = esp_camera_init(&config);
    if (err != ESP_OK)
    {
        Serial.printf("Camera initialization FAILED: 0x%x\n", err);
        return false;
    }

    Serial.println("Camera initialized successfully.");
    return true;
}

// Returns a malloc'd JPEG. Caller must free(*out).
bool captureJpeg(uint8_t **out, size_t *outLen)
{
    *out = nullptr;
    *outLen = 0;

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb)
    {
        Serial.println("captureJpeg: esp_camera_fb_get() returned null.");
        return false;
    }

    bool ok;
    if (fb->format == PIXFORMAT_JPEG)
    {
        *out = (uint8_t *)malloc(fb->len);
        ok = (*out != nullptr);
        if (ok) { memcpy(*out, fb->buf, fb->len); *outLen = fb->len; }
    }
    else
    {
        ok = frame2jpg(fb, 80, out, outLen);
    }
    esp_camera_fb_return(fb);

    if (!ok)
        Serial.println("captureJpeg: JPEG conversion failed.");
    return ok;
}


// =====================================================
// OPENAI CLASSIFY — same request shape as sylvan_esp32cam.ino, but every
// step prints what it did instead of silently returning 'E'.
// =====================================================

void *largeAlloc(size_t size)
{
    return psramFound() ? ps_malloc(size) : malloc(size);
}

void classifyPhoto(const uint8_t *jpg, size_t jpgLen)
{
    Serial.println("---- classifyPhoto() ----");

    if (jpg == nullptr || jpgLen == 0)
    {
        Serial.println("ABORT: no photo to send.");
        return;
    }
    Serial.printf("Photo: %u bytes, starts with 0x%02X 0x%02X (should be FF D8 for JPEG)\n",
                  (unsigned)jpgLen, jpg[0], jpg[1]);

    if (WiFi.status() != WL_CONNECTED)
    {
        Serial.println("ABORT: Wi-Fi not connected.");
        return;
    }

    size_t keyLen = strlen(OPENAI_API_KEY);
    bool looksReal = keyLen > 20 && strncmp(OPENAI_API_KEY, "sk-", 3) == 0 &&
                      strstr(OPENAI_API_KEY, "PASTE") == nullptr;
    Serial.printf("OPENAI_API_KEY: length=%u, starts with 'sk-'=%s, still a placeholder=%s\n",
                  (unsigned)keyLen, strncmp(OPENAI_API_KEY, "sk-", 3) == 0 ? "yes" : "NO",
                  looksReal ? "no" : "YES (this alone would cause OpenAI to reject the request)");
    if (!looksReal)
        Serial.println("ABORT (would fail anyway): paste a real key at the top of this file first.");

    String head = String("{\"model\":\"") + OPENAI_MODEL +
                  "\",\"reasoning_effort\":\"none\",\"max_completion_tokens\":16,"
                  "\"messages\":[{\"role\":\"user\","
                  "\"content\":[{\"type\":\"text\",\"text\":\"" + OPENAI_PROMPT +
                  "\"},{\"type\":\"image_url\",\"image_url\":{\"detail\":\"low\","
                  "\"url\":\"data:image/jpeg;base64,";
    const char *tail = "\"}}]}]}";

    size_t b64Len = 0;
    mbedtls_base64_encode(nullptr, 0, &b64Len, jpg, jpgLen);
    size_t bodyCap = head.length() + b64Len + strlen(tail) + 1;
    Serial.printf("Request body will be about %u bytes (base64 image ~%u bytes). Free heap: %u\n",
                  (unsigned)bodyCap, (unsigned)b64Len, (unsigned)ESP.getFreeHeap());

    char *body = (char *)largeAlloc(bodyCap);
    if (body == nullptr)
    {
        Serial.printf("ABORT: allocation of %u bytes failed (out of memory).\n", (unsigned)bodyCap);
        return;
    }

    memcpy(body, head.c_str(), head.length());
    size_t written = 0;
    if (mbedtls_base64_encode((unsigned char *)body + head.length(), b64Len, &written,
                              jpg, jpgLen) != 0)
    {
        free(body);
        Serial.println("ABORT: base64 encoding failed.");
        return;
    }
    size_t bodyLen = head.length() + written;
    memcpy(body + bodyLen, tail, strlen(tail));
    bodyLen += strlen(tail);

    WiFiClientSecure client;
    client.setCACert(ROOT_CA_OPENAI);

    HTTPClient http;
    String url = String("https://") + OPENAI_HOST + OPENAI_PATH;
    Serial.printf("POST %s\n", url.c_str());

    if (!http.begin(client, url))
    {
        free(body);
        Serial.println("ABORT: http.begin() failed (bad URL, or TLS setup issue).");
        return;
    }
    http.setConnectTimeout(5000);
    http.setTimeout(15000);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", String("Bearer ") + OPENAI_API_KEY);

    unsigned long startedAt = millis();
    int status = http.POST((uint8_t *)body, bodyLen);
    unsigned long elapsed = millis() - startedAt;
    String response = http.getString();
    http.end();
    free(body);

    Serial.printf("HTTP status: %d, elapsed: %lu ms\n", status, elapsed);
    Serial.println("---- raw response body ----");
    Serial.println(response);
    Serial.println("---- end response body ----");

    if (status != 200)
    {
        Serial.println("RESULT: no verdict (non-200 status). Check the error message above --");
        Serial.println("common causes: 401/403 = bad or missing API key, 404 = wrong model name,");
        Serial.println("429 = rate limit or no quota, -1/-11 = network/TLS/timeout before OpenAI answered.");
        return;
    }

    int at = response.indexOf("\"content\":");
    if (at < 0)
    {
        Serial.println("RESULT: no verdict -- response had no \"content\" field (unexpected shape).");
        return;
    }
    String answer = response.substring(at + 10, at + 60);
    answer.toUpperCase();
    Serial.printf("Model's raw answer field: %s\n", answer.c_str());

    if (answer.indexOf("TREE") >= 0)
        Serial.println("RESULT: TREE");
    else if (answer.indexOf("OBJECT") >= 0)
        Serial.println("RESULT: OBJECT");
    else
        Serial.println("RESULT: UNCLEAR -- model didn't answer TREE or OBJECT. "
                        "Check the raw response above; the prompt may need tightening.");
}


// =====================================================
// SETUP / LOOP
// =====================================================

unsigned long lastCaptureAt = 0;

void runOneCycle()
{
    Serial.println();
    Serial.println("========================================");
    Serial.printf("Capturing... (free heap: %u)\n", (unsigned)ESP.getFreeHeap());

    if (!cameraReady)
    {
        Serial.println("ABORT: camera not ready.");
        return;
    }

    uint8_t *jpg = nullptr;
    size_t jpgLen = 0;
    unsigned long t0 = millis();
    bool ok = captureJpeg(&jpg, &jpgLen);
    Serial.printf("Capture: %s in %lu ms\n", ok ? "OK" : "FAILED", millis() - t0);

    if (ok)
        classifyPhoto(jpg, jpgLen);

    if (jpg) free(jpg);
    Serial.println("========================================");
}

void setup()
{
    Serial.begin(115200);
    delay(2000);
    Serial.println();
    Serial.println("==== Sylvan ESP32-CAM debug: capture + OpenAI classify ====");

    if (initCamera())
        cameraReady = true;
    else
        Serial.println("Camera failed to init -- captures will be skipped.");

    Serial.printf("Connecting to Wi-Fi \"%s\"...\n", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    unsigned long wifiStart = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 20000)
    {
        delay(300);
        Serial.print(".");
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED)
        Serial.printf("Wi-Fi connected, IP: %s\n", WiFi.localIP().toString().c_str());
    else
        Serial.println("WARNING: Wi-Fi did NOT connect within 20 s -- classify calls will abort.");

    Serial.println();
    Serial.println("Type 'c' + Enter in the Serial Monitor to capture immediately,");
    Serial.printf("or just wait -- it repeats automatically every %lu ms.\n", CAPTURE_INTERVAL_MS);

    runOneCycle();
    lastCaptureAt = millis();
}

void loop()
{
    if (Serial.available() && Serial.read() == 'c')
    {
        while (Serial.available()) Serial.read();   // discard the trailing newline
        runOneCycle();
        lastCaptureAt = millis();
    }

    if (millis() - lastCaptureAt >= CAPTURE_INTERVAL_MS)
    {
        runOneCycle();
        lastCaptureAt = millis();
    }
}
