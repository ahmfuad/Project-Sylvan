#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <WebSocketsClient.h>
#include <time.h>

#include "esp_camera.h"
#include "img_converters.h"
#include "esp_http_server.h"
#include "esp_random.h"
#include "mbedtls/base64.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

// =====================================================
// PROJECT SYLVAN - ESP32-CAM
//
// 1. GC2145 camera (RGB565 -> JPEG in software)
// 2. Receive sample packets from the ATmega32A over UART
// 3. Take a photo automatically for every sample
// 4. Join the home Wi-Fi (station mode) and upload each sample to the
//    server: POST /api/samples (readings in the query string, the JPEG
//    as the raw body). See uploadSampleToServer() below.
// 5. Push live video to the deployed dashboard's Live page over a
//    WebSocket to /ws/device (hello + heartbeat JSON, JPEG frames as
//    binary), only while someone is actually watching. See the "LIVE
//    VIEW WEBSOCKET" section below.
// 6. Local web portal (port 80) + MJPEG live stream (port 81), for
//    debugging on the same Wi-Fi network — independent of 4 and 5.
//
// ATmega packets (9600 baud, 8N1, one per line):
//   <S,T=30,H=66,L=235>\n   successful sample
//   <F>\n                   failed sample
//
// Reply to the ATmega after each sample photo is classified by OpenAI:
//   <C,T>\n                 tub tree / potted plant
//   <C,O>\n                 random object
//   <C,E>\n                 no answer (no photo, no Wi-Fi, API error)
//
// UART: ESP GPIO14 = RX from ATmega PD1/TXD (through a 1k/2k divider)
//       ESP GPIO13 = TX to ATmega PD0/RXD (direct wire; keep the SD slot empty)
// =====================================================


// =====================================================
// CAMERA PINOUT (AI-Thinker compatible, RBD-1407)
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

#define FLASH_LED_GPIO     4


// =====================================================
// ATMEGA UART
// =====================================================

#define ATMEGA_RX_PIN 14
#define ATMEGA_TX_PIN 13
#define ATMEGA_BAUD   9600      // change to 4800 if the ATmega side is changed

HardwareSerial AtmegaSerial(2);


// =====================================================
// WIFI / SERVERS
// =====================================================

// ---- EDIT THESE THREE FOR YOUR SETUP ----
const char *WIFI_SSID = "Rayhan";
const char *WIFI_PASSWORD = "qqqqqqqq";
const char *DEVICE_KEY = "989566480edd2d4da74e54793490a4ae5cfd2ef77a79dc255a8e402469cfeb86";
// ------------------------------------------

const char *SERVER_HOST = "sylvan.daftar-e.com";
const uint16_t SERVER_PORT = 443;
const char *UPLOAD_PATH = "/api/samples";
const char *DEVICE_WS_PATH = "/ws/device";
const char *FW_VERSION = "sylvan-esp32cam-1.1";

// ---- OpenAI (tree vs. random object) ----
// Paste your key here before uploading, and don't commit it: anyone with the board can read it
// back out of flash, so give this key a monthly spending limit in the OpenAI dashboard.
const char *OPENAI_API_KEY = "sample_key";
const char *OPENAI_HOST = "api.openai.com";
const char *OPENAI_PATH = "/v1/chat/completions";
//gpt 5.5
const char *OPENAI_MODEL = "gpt-5.5";

const char *OPENAI_PROMPT =
    "Photo from a small rover in a rooftop garden. Reply with exactly one word: "
    "TREE if the main object is a plant or small tree in a tub, pot or planter; "
    "otherwise OBJECT.";

// api.openai.com chains to GTS Root R4, which is also cross-signed by GlobalSign Root CA.
// Both are trusted so a switch between the two chains doesn't break classification.
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

// ISRG Root X1 — the root certificate that issued the server's Let's Encrypt certificate
// (valid until 2035-06-04). Used so the ESP32 actually verifies it is talking to the real
// server before sending the device key, instead of skipping certificate checks entirely.
// Source: https://letsencrypt.org/certs/isrgrootx1.pem — if the server ever switches away
// from Let's Encrypt, replace this with that CA's root certificate.
const char *ROOT_CA_ISRG_X1 PROGMEM = R"CERT(
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
)CERT";

WebServer server(80);

httpd_handle_t streamServer = nullptr;
SemaphoreHandle_t cameraMutex = nullptr;   // shared by capture, stream, samples
bool cameraReady = false;
bool streamReady = false;

const uint16_t STREAM_PORT = 81;
const unsigned long STREAM_FRAME_INTERVAL_MS = 200;  // at most 5 FPS
const uint8_t STREAM_JPEG_QUALITY = 65;
const uint8_t CAPTURE_JPEG_QUALITY = 80;
const uint8_t SAMPLE_JPEG_QUALITY = 80;

#define PART_BOUNDARY "sylvanframe"
static const char *STREAM_CONTENT_TYPE =
    "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char *STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
static const char *STREAM_PART =
    "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

// ---- Live view over WebSocket, to the deployed dashboard's Live page ----
WebSocketsClient wsDevice;
uint16_t liveTargetFps = 5;          // overwritten by the server's `config` message on connect
uint8_t liveJpegQuality = 65;        // overwritten by the server's `config` message on connect
volatile int liveViewerCount = 0;    // set by the server's `viewers` message
bool liveStreamActive = false;       // true once a frame has actually been sent this session
unsigned long lastLiveHeartbeatAt = 0;
unsigned long lastLiveFrameAt = 0;
const unsigned long LIVE_HEARTBEAT_INTERVAL_MS = 5000;   // well under the server's 30s timeout
const size_t LIVE_MAX_FRAME_BYTES = 190000;              // stay under the server's 200 KB cap


// =====================================================
// SAMPLE DATA
// =====================================================

struct SampleRecord
{
    uint32_t id;
    bool ok;
    float t;
    float h;
    float l;
    unsigned long atMs;
    uint8_t *jpg;       // photo taken when the sample arrived (may be null)
    size_t jpgLen;
};

const uint8_t HISTORY_SIZE = 10;
SampleRecord sampleHistory[HISTORY_SIZE];   // zero-initialized
uint8_t historyCount = 0;
uint8_t historyHead = 0;

uint32_t nextSampleId = 1;
uint32_t sampleCount = 0;     // successful samples
uint32_t failedCount = 0;     // failed samples
bool atmegaSeen = false;
unsigned long lastAtmegaPacket = 0;

// Changes on every boot so the browser never shows an old photo
// for a sample number that was reused after a reset.
uint32_t bootId = 0;

char atmegaBuffer[100];
uint8_t atmegaBufferIndex = 0;


// =====================================================
// CAMERA INITIALIZATION
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

    // GC2145 has no hardware JPEG encoder
    config.pixel_format = PIXFORMAT_RGB565;
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

    Serial.println("Initializing camera...");

    esp_err_t err = esp_camera_init(&config);
    if (err != ESP_OK)
    {
        Serial.printf("Camera initialization FAILED: 0x%x\n", err);
        return false;
    }

    Serial.println("Camera initialized successfully.");

    sensor_t *sensor = esp_camera_sensor_get();
    if (sensor != nullptr)
    {
        Serial.printf("Detected camera PID: 0x%04X\n", sensor->id.PID);

        if (sensor->id.PID == 0x2145)
            Serial.println("Camera sensor = GC2145");
        else if (sensor->id.PID == 0x26)
            Serial.println("Camera sensor = OV2640");
        else
            Serial.println("Different camera sensor detected.");
    }

    return true;
}


// =====================================================
// SHARED CAPTURE HELPER
// Returns a malloc'd JPEG. Caller must free(*out).
// =====================================================

bool captureJpeg(uint8_t quality, uint8_t **out, size_t *outLen,
                 TickType_t waitTicks)
{
    *out = nullptr;
    *outLen = 0;

    if (!cameraReady || cameraMutex == nullptr)
        return false;

    if (xSemaphoreTake(cameraMutex, waitTicks) != pdTRUE)
        return false;

    bool ok = false;
    camera_fb_t *fb = esp_camera_fb_get();

    if (fb)
    {
        if (fb->format == PIXFORMAT_JPEG)
        {
            *out = (uint8_t *)malloc(fb->len);
            if (*out)
            {
                memcpy(*out, fb->buf, fb->len);
                *outLen = fb->len;
                ok = true;
            }
        }
        else
        {
            ok = frame2jpg(fb, quality, out, outLen);
        }

        esp_camera_fb_return(fb);
    }

    xSemaphoreGive(cameraMutex);

    if (!ok && *out)
    {
        free(*out);
        *out = nullptr;
        *outLen = 0;
    }

    return ok && *out != nullptr;
}


// =====================================================
// MJPEG STREAM (port 81)
// =====================================================

static esp_err_t streamHandler(httpd_req_t *req)
{
    esp_err_t res = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
    if (res != ESP_OK)
        return res;

    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");

    Serial.println("Stream client connected.");

    char partHeader[64];
    uint8_t failures = 0;

    while (true)
    {
        unsigned long frameStart = millis();

        uint8_t *jpg = nullptr;
        size_t jpgLen = 0;

        if (!captureJpeg(STREAM_JPEG_QUALITY, &jpg, &jpgLen,
                         pdMS_TO_TICKS(2000)))
        {
            if (++failures >= 10)
            {
                Serial.println("Stream: too many capture failures.");
                res = ESP_FAIL;
                break;
            }
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }

        failures = 0;

        res = httpd_resp_send_chunk(req, STREAM_BOUNDARY,
                                    strlen(STREAM_BOUNDARY));

        if (res == ESP_OK)
        {
            int headerLen = snprintf(partHeader, sizeof(partHeader),
                                     STREAM_PART, (unsigned int)jpgLen);
            res = httpd_resp_send_chunk(req, partHeader, headerLen);
        }

        if (res == ESP_OK)
            res = httpd_resp_send_chunk(req, (const char *)jpg, jpgLen);

        free(jpg);

        if (res != ESP_OK)
            break;   // browser closed the stream

        unsigned long elapsed = millis() - frameStart;
        if (elapsed < STREAM_FRAME_INTERVAL_MS)
            vTaskDelay(pdMS_TO_TICKS(STREAM_FRAME_INTERVAL_MS - elapsed));
    }

    Serial.println("Stream client disconnected.");
    return res;
}

bool startStreamServer()
{
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = STREAM_PORT;
    config.ctrl_port = 32081;
    config.max_uri_handlers = 2;
    config.stack_size = 8192;
    config.lru_purge_enable = true;

    if (httpd_start(&streamServer, &config) != ESP_OK)
    {
        Serial.println("Stream server FAILED to start.");
        streamServer = nullptr;
        return false;
    }

    httpd_uri_t streamUri = {};
    streamUri.uri = "/stream";
    streamUri.method = HTTP_GET;
    streamUri.handler = streamHandler;
    streamUri.user_ctx = nullptr;

    httpd_register_uri_handler(streamServer, &streamUri);

    Serial.printf("Stream server started on port %u\n", STREAM_PORT);
    return true;
}


// =====================================================
// UPLOAD ONE SAMPLE TO THE SERVER (POST /api/samples)
// =====================================================
//
// Fixed contract — do not change without also updating the server:
//   POST https://<SERVER_HOST><UPLOAD_PATH>?ok=1&t=<temp>&h=<humidity>&l=<lux>
//   X-Device-Key: <DEVICE_KEY>
//   X-Upload-Id: <unique per sample>     lets a retry return the same result safely
//   Content-Type: image/jpeg             only present when a photo body follows
//   <raw JPEG bytes, or an empty body when ok=0 or the photo capture failed>
//
// Retries once, with the SAME X-Upload-Id, only for a network error/timeout or a 5xx —
// a 4xx means the request itself is wrong, and retrying an unchanged request cannot help.
bool uploadSampleToServer(uint32_t sampleId, bool ok, float t, float h, float l,
                           const uint8_t *jpg, size_t jpgLen)
{
    if (WiFi.status() != WL_CONNECTED)
    {
        Serial.println("Upload skipped: Wi-Fi not connected.");
        return false;
    }

    String url = String("https://") + SERVER_HOST + UPLOAD_PATH + "?ok=" + (ok ? "1" : "0");
    if (ok)
    {
        url += "&t=" + String(t, 1);
        url += "&h=" + String(h, 1);
        url += "&l=" + String(lround(l));
    }

    // bootId changes every boot, sampleId is unique within a boot: unique overall, and
    // matches the server's X-Upload-Id charset (letters, digits, _ and -).
    String uploadId = String(bootId) + "-" + String(sampleId);
    bool hasPhoto = (jpg != nullptr && jpgLen > 0);

    for (uint8_t attempt = 1; attempt <= 2; attempt++)
    {
        WiFiClientSecure client;
        client.setCACert(ROOT_CA_ISRG_X1);

        HTTPClient http;
        if (!http.begin(client, url))
        {
            Serial.println("Upload: http.begin() failed (bad URL?).");
            return false;
        }

        http.setTimeout(15000);
        http.setConnectTimeout(10000);
        http.addHeader("X-Device-Key", DEVICE_KEY);
        http.addHeader("X-Upload-Id", uploadId);
        if (hasPhoto)
            http.addHeader("Content-Type", "image/jpeg");

        int status = hasPhoto
            ? http.POST(const_cast<uint8_t *>(jpg), jpgLen)
            : http.POST("");   // empty body; no Content-Type, matching the contract

        String body = http.getString();
        http.end();

        if (status == 200 || status == 201)
        {
            Serial.printf("Uploaded sample #%lu (id=%s): HTTP %d %s\n",
                          (unsigned long)sampleId, uploadId.c_str(), status, body.c_str());
            return true;
        }

        Serial.printf("Upload attempt %u for sample #%lu failed: HTTP %d %s\n",
                      attempt, (unsigned long)sampleId, status, body.c_str());

        if (status > 0 && status < 500)
            break;   // a client-side error (4xx) — retrying the same request won't help

        if (attempt == 1)
            delay(2000);
    }

    return false;
}


// =====================================================
// LIVE VIEW WEBSOCKET (/ws/device)
// =====================================================
//
// Separate from uploadSampleToServer() above: this is a long-lived connection, not a
// one-shot request. Protocol (fixed by the server, see server/src/realtime/protocol.ts):
//   -> {"type":"hello","fw":"...","bootId":"..."}          once, right after connecting
//   -> {"type":"heartbeat","rssi":...,"uptimeS":...,"freeHeap":...,"streaming":...}
//                                                           every few seconds, always
//   <- {"type":"config","targetFps":N,"jpegQuality":N}     once, right after connecting
//   <- {"type":"viewers","count":N}                        whenever the watcher count changes
//   -> binary JPEG frames                                  only while count > 0
//
// Frames are captured through the same captureJpeg()/cameraMutex used by the sample photo
// and the local MJPEG stream, so all three can never corrupt each other's frame buffer.

// Very small, fixed-shape JSON from our own server — hand-parsing avoids pulling in a JSON
// library for two integer fields, matching how the rest of this file builds/reads JSON.
long jsonIntField(const String &json, const char *key)
{
    String needle = String("\"") + key + "\":";
    int at = json.indexOf(needle);
    if (at < 0)
        return -1;
    return json.substring(at + needle.length()).toInt();
}

void onWsDeviceEvent(WStype_t type, uint8_t *payload, size_t length)
{
    switch (type)
    {
        case WStype_CONNECTED:
        {
            Serial.println("Live WS: connected to /ws/device");
            liveStreamActive = false;
            liveViewerCount = 0;
            String hello = String("{\"type\":\"hello\",\"fw\":\"") + FW_VERSION +
                           "\",\"bootId\":\"" + String(bootId) + "\"}";
            wsDevice.sendTXT(hello);
            break;
        }

        case WStype_DISCONNECTED:
            Serial.println("Live WS: disconnected");
            liveStreamActive = false;
            liveViewerCount = 0;
            break;

        case WStype_TEXT:
        {
            String msg(reinterpret_cast<char *>(payload), length);

            if (msg.indexOf("\"type\":\"config\"") >= 0)
            {
                long fps = jsonIntField(msg, "targetFps");
                long quality = jsonIntField(msg, "jpegQuality");
                if (fps > 0)
                    liveTargetFps = (uint16_t)fps;
                if (quality > 0)
                    liveJpegQuality = (uint8_t)quality;
                Serial.printf("Live WS: config fps=%u quality=%u\n", liveTargetFps, liveJpegQuality);
            }
            else if (msg.indexOf("\"type\":\"viewers\"") >= 0)
            {
                long count = jsonIntField(msg, "count");
                liveViewerCount = count >= 0 ? (int)count : 0;
                Serial.printf("Live WS: %d viewer(s) watching\n", liveViewerCount);
            }
            break;
        }

        default:
            break;   // WStype_ERROR/PING/PONG/fragments: nothing to do
    }
}

void sendLiveHeartbeatIfDue()
{
    if (!wsDevice.isConnected())
        return;

    unsigned long now = millis();
    if (now - lastLiveHeartbeatAt < LIVE_HEARTBEAT_INTERVAL_MS)
        return;
    lastLiveHeartbeatAt = now;

    String heartbeat = String("{\"type\":\"heartbeat\",\"rssi\":") + String(WiFi.RSSI()) +
                        ",\"uptimeS\":" + String(now / 1000) +
                        ",\"freeHeap\":" + String(ESP.getFreeHeap()) +
                        ",\"streaming\":" + (liveStreamActive ? "true" : "false") + "}";
    wsDevice.sendTXT(heartbeat);
}

void sendLiveFrameIfDue()
{
    if (!wsDevice.isConnected() || liveViewerCount <= 0 || !cameraReady)
    {
        liveStreamActive = false;
        return;
    }

    unsigned long now = millis();
    unsigned long intervalMs = 1000UL / (liveTargetFps > 0 ? liveTargetFps : 1);
    if (now - lastLiveFrameAt < intervalMs)
        return;

    uint8_t *jpg = nullptr;
    size_t jpgLen = 0;

    // waitTicks = 0: never block loop() for this — skip the tick if the camera is busy
    // with a sample photo or the local MJPEG stream, and try again next time.
    if (!captureJpeg(liveJpegQuality, &jpg, &jpgLen, 0))
        return;

    lastLiveFrameAt = now;

    if (jpgLen > 0 && jpgLen <= LIVE_MAX_FRAME_BYTES)
    {
        wsDevice.sendBIN(jpg, jpgLen);
        liveStreamActive = true;
    }

    free(jpg);
}


// =====================================================
// CLASSIFY A SAMPLE PHOTO WITH OPENAI (tree vs. object)
// =====================================================
//
// Returns 'T' (tree), 'O' (object) or 'E' (no answer). Timeouts are kept short enough that the
// ATmega (which waits CLASSIFY_TIMEOUT_MS = 20 s for the reply) always hears back in time.

void *largeAlloc(size_t size)
{
    return psramFound() ? ps_malloc(size) : malloc(size);
}

char classifyPhoto(const uint8_t *jpg, size_t jpgLen)
{
    if (jpg == nullptr || jpgLen == 0)
    {
        Serial.println("OpenAI: skipped, no photo.");
        return 'E';
    }
    if (WiFi.status() != WL_CONNECTED)
    {
        Serial.println("OpenAI: skipped, Wi-Fi not connected.");
        return 'E';
    }
    if (strncmp(OPENAI_API_KEY, "sk-PASTE", 8) == 0)
    {
        Serial.println("OpenAI: skipped, OPENAI_API_KEY is still the placeholder.");
        return 'E';
    }

    // GPT-5.x are reasoning models: they reject max_tokens/temperature, and reasoning tokens
    // count against max_completion_tokens, so reasoning is turned off for this one-word answer.
    String head = String("{\"model\":\"") + OPENAI_MODEL +
                  "\",\"reasoning_effort\":\"none\",\"max_completion_tokens\":16,"
                  "\"messages\":[{\"role\":\"user\","
                  "\"content\":[{\"type\":\"text\",\"text\":\"" + OPENAI_PROMPT +
                  "\"},{\"type\":\"image_url\",\"image_url\":{\"detail\":\"low\","
                  "\"url\":\"data:image/jpeg;base64,";
    const char *tail = "\"}}]}]}";

    size_t b64Len = 0;
    mbedtls_base64_encode(nullptr, 0, &b64Len, jpg, jpgLen);   // required size, incl. NUL
    size_t bodyCap = head.length() + b64Len + strlen(tail) + 1;
    char *body = (char *)largeAlloc(bodyCap);
    if (body == nullptr)
    {
        Serial.printf("OpenAI: out of memory for a %u-byte request.\n", (unsigned int)bodyCap);
        return 'E';
    }

    memcpy(body, head.c_str(), head.length());
    size_t written = 0;
    if (mbedtls_base64_encode((unsigned char *)body + head.length(), b64Len, &written,
                              jpg, jpgLen) != 0)
    {
        free(body);
        Serial.println("OpenAI: base64 encoding failed.");
        return 'E';
    }
    size_t bodyLen = head.length() + written;
    memcpy(body + bodyLen, tail, strlen(tail));
    bodyLen += strlen(tail);

    WiFiClientSecure client;
    client.setCACert(ROOT_CA_OPENAI);

    HTTPClient http;
    String url = String("https://") + OPENAI_HOST + OPENAI_PATH;
    if (!http.begin(client, url))
    {
        free(body);
        Serial.println("OpenAI: http.begin() failed.");
        return 'E';
    }
    http.setConnectTimeout(5000);
    http.setTimeout(10000);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", String("Bearer ") + OPENAI_API_KEY);

    unsigned long startedAt = millis();
    int status = http.POST((uint8_t *)body, bodyLen);
    String response = http.getString();
    http.end();
    free(body);

    if (status != 200)
    {
        Serial.printf("OpenAI: HTTP %d after %lu ms: %s\n", status, millis() - startedAt,
                      response.substring(0, 300).c_str());
        return 'E';
    }

    // Tiny fixed-shape reply; hand-parse the first "content" like jsonIntField() does.
    int at = response.indexOf("\"content\":");
    if (at < 0)
    {
        Serial.println("OpenAI: reply had no content field.");
        return 'E';
    }
    String answer = response.substring(at + 10, at + 60);
    answer.toUpperCase();

    char verdict = answer.indexOf("TREE") >= 0     ? 'T'
                   : answer.indexOf("OBJECT") >= 0 ? 'O'
                                                   : 'E';
    Serial.printf("OpenAI: %s in %lu ms (answer: %s)\n",
                  verdict == 'T' ? "TREE" : verdict == 'O' ? "OBJECT" : "UNCLEAR",
                  millis() - startedAt, answer.c_str());
    return verdict;
}

void sendClassificationToAtmega(char verdict)
{
    AtmegaSerial.printf("<C,%c>\n", verdict);
    AtmegaSerial.flush();
    Serial.printf("ATmega TX: <C,%c>\n", verdict);
}


// =====================================================
// STORE A SAMPLE (+ PHOTO)
// =====================================================

void storeSample(bool ok, float t, float h, float l)
{
    SampleRecord &slot = sampleHistory[historyHead];

    // Oldest record is overwritten; release its photo first.
    if (slot.jpg)
    {
        free(slot.jpg);
        slot.jpg = nullptr;
        slot.jpgLen = 0;
    }

    slot.id = nextSampleId++;
    slot.ok = ok;
    slot.t = ok ? t : 0;
    slot.h = ok ? h : 0;
    slot.l = ok ? l : 0;
    slot.atMs = millis();

    if (ok)
        sampleCount++;
    else
        failedCount++;

    atmegaSeen = true;
    lastAtmegaPacket = slot.atMs;

    // The rover is stopped beside the object right now, so take its photo.
    if (cameraReady)
    {
        if (captureJpeg(SAMPLE_JPEG_QUALITY, &slot.jpg, &slot.jpgLen,
                        pdMS_TO_TICKS(3000)))
        {
            Serial.printf("Sample #%lu photo: %u bytes\n",
                          (unsigned long)slot.id, (unsigned int)slot.jpgLen);
        }
        else
        {
            Serial.printf("Sample #%lu photo FAILED\n", (unsigned long)slot.id);
        }
    }

    // The rover waits (showing "Classifying...") until this reply arrives, so classify and
    // answer first, and only then spend time on the server upload.
    sendClassificationToAtmega(classifyPhoto(slot.jpg, slot.jpgLen));

    uploadSampleToServer(slot.id, slot.ok, slot.t, slot.h, slot.l, slot.jpg, slot.jpgLen);

    historyHead = (historyHead + 1) % HISTORY_SIZE;
    if (historyCount < HISTORY_SIZE)
        historyCount++;

    if (ok)
        Serial.printf("Sample #%lu: T=%.1f C, H=%.1f %%, L=%.0f lux\n",
                      (unsigned long)slot.id, t, h, l);
    else
        Serial.printf("Sample #%lu: FAILED (rover sensor error)\n",
                      (unsigned long)slot.id);
}


// =====================================================
// PROCESS ATMEGA PACKET
// =====================================================

void processAtmegaPacket(const char *packet)
{
    String line = String(packet);
    line.trim();

    if (line.length() == 0)
        return;

    Serial.print("ATmega RX: ");
    Serial.println(line);

    if (line == "<F>" || line == "F")
    {
        storeSample(false, 0, 0, 0);
        return;
    }

    if (line.startsWith("<S,"))
        line.remove(0, 3);
    else if (line.startsWith("S,"))
        line.remove(0, 2);

    if (line.endsWith(">"))
        line.remove(line.length() - 1);

    float t, h, l;
    int result = sscanf(line.c_str(), "T=%f,H=%f,L=%f", &t, &h, &l);

    if (result == 3)
        storeSample(true, t, h, l);
    else
        Serial.println("Invalid ATmega packet (ignored).");
}


// =====================================================
// NON-BLOCKING UART RECEIVER
// =====================================================

void readAtmegaUART()
{
    while (AtmegaSerial.available())
    {
        char c = AtmegaSerial.read();

        if (c == '\r')
            continue;

        if (c == '\n')
        {
            atmegaBuffer[atmegaBufferIndex] = '\0';
            processAtmegaPacket(atmegaBuffer);
            atmegaBufferIndex = 0;
            continue;
        }

        if (atmegaBufferIndex < sizeof(atmegaBuffer) - 1)
            atmegaBuffer[atmegaBufferIndex++] = c;
        else
            atmegaBufferIndex = 0;   // oversized packet, reset
    }
}


// =====================================================
// WEB PAGE
// =====================================================

const char INDEX_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Project Sylvan</title>
<style>
* { box-sizing: border-box; }

body {
    margin: 0;
    font-family: Inter, Arial, sans-serif;
    background: linear-gradient(135deg, #07110d, #0e2118, #102b1d);
    color: #eef7f1;
    min-height: 100vh;
}

.container { width: min(1100px, calc(100% - 30px)); margin: auto; padding: 30px 0 50px; }

.header { margin-bottom: 28px; }
.title { font-size: clamp(32px, 6vw, 55px); font-weight: 700; margin: 0; }
.subtitle { color: #9eb5a6; margin-top: 8px; font-size: 16px; }

.status-row { display: flex; align-items: center; gap: 10px; margin-top: 18px; }
.status-dot { width: 11px; height: 11px; border-radius: 50%; background: #888; flex: none; }
.status-dot.online { background: #4ade80; box-shadow: 0 0 12px rgba(74, 222, 128, .8); }
.status-dot.offline { background: #ef4444; }
#connectionText { color: #c5d4c9; font-size: 14px; }

.card {
    margin-bottom: 25px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 24px;
    overflow: hidden;
    backdrop-filter: blur(12px);
}
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 22px; }
.card-title { font-size: 20px; font-weight: 600; }
.card-subtitle { color: #93a79a; font-size: 13px; margin-top: 5px; }

button, .download-button {
    border: none;
    background: #35b768;
    color: white;
    padding: 12px 20px;
    border-radius: 12px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    text-align: center;
    display: inline-block;
    transition: transform .15s, background .15s;
}
button:hover { background: #2ca35c; transform: translateY(-1px); }
button:active { transform: translateY(0); }
button:disabled { opacity: .5; cursor: wait; transform: none; }
.download-button { background: #244333; }
.download-button.small { padding: 8px 12px; font-size: 13px; border-radius: 10px; }

.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.info { color: #9eb5a6; font-size: 13px; padding: 14px 22px; }
[hidden] { display: none !important; }

.badge { font-size: 12px; font-weight: 700; padding: 5px 10px; border-radius: 999px; }
.badge.ok { background: rgba(74, 222, 128, .15); color: #4ade80; }
.badge.fail { background: rgba(239, 68, 68, .15); color: #f87171; }

/* Latest sample */
.latest { display: grid; grid-template-columns: 1.3fr 1fr; }
.metrics { display: grid; gap: 14px; padding: 0 22px 22px; align-content: start; }
.metric {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    padding: 16px 18px;
}
.metric-label { color: #95aa9c; font-size: 13px; margin-bottom: 8px; }
.metric-value { font-size: 34px; font-weight: 700; letter-spacing: -1px; }
.metric-unit { color: #9eb5a6; font-size: 15px; margin-left: 4px; }

/* Images */
.image-container {
    width: 100%;
    min-height: 260px;
    background: #050907;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
}
.image-container img { display: block; width: 100%; max-height: 650px; object-fit: contain; }
.image-message {
    position: absolute;
    color: #718277;
    font-size: 15px;
    padding: 16px;
    text-align: center;
    background: rgba(5, 9, 7, .85);
    border-radius: 12px;
}

/* History grid */
.history-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 16px;
    padding: 0 22px 22px;
}
.sample {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    overflow: hidden;
}
.thumb {
    aspect-ratio: 4 / 3;
    background: #050907;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #718277;
    font-size: 13px;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.sample-body { padding: 12px 14px 14px; display: grid; gap: 8px; }
.sample-top { display: flex; justify-content: space-between; align-items: center; }
.sample-read { font-size: 14px; color: #dce8df; }
.sample-when { font-size: 12px; color: #93a79a; }
.empty { color: #718277; padding: 0 22px 22px; }

.footer { text-align: center; color: #718277; font-size: 13px; margin-top: 25px; }

@media (max-width: 760px) {
    .latest { grid-template-columns: 1fr; }
    .metrics { padding-top: 22px; }
    .card-header { flex-direction: column; align-items: flex-start; }
    .card-header button, .card-header .actions { width: 100%; }
}
</style>
</head>

<body>
<div class="container">

    <div class="header">
        <h1 class="title">Sylvan</h1>
        <div class="subtitle">Autonomous plant monitoring rover</div>
        <div class="status-row">
            <div id="statusDot" class="status-dot"></div>
            <span id="connectionText">Waiting for first sample from the rover...</span>
        </div>
    </div>

    <!-- LATEST SAMPLE -->
    <section class="card" aria-labelledby="latestTitle">
        <div class="card-header">
            <div>
                <div class="card-title" id="latestTitle">Latest Sample</div>
                <div class="card-subtitle" id="latestWhen">No sample yet</div>
            </div>
            <div class="actions">
                <span id="latestBadge" class="badge" hidden></span>
                <a id="latestDownload" class="download-button" hidden>Download photo</a>
            </div>
        </div>
        <div class="latest">
            <div class="image-container">
                <div id="latestMessage" class="image-message" role="status">
                    The photo appears here when the rover collects a sample
                </div>
                <img id="latestPhoto" alt="Photo taken at the latest sample" hidden>
            </div>
            <div class="metrics">
                <div class="metric">
                    <div class="metric-label">AIR TEMPERATURE</div>
                    <span id="temperature" class="metric-value">--</span><span class="metric-unit">°C</span>
                </div>
                <div class="metric">
                    <div class="metric-label">RELATIVE HUMIDITY</div>
                    <span id="humidity" class="metric-value">--</span><span class="metric-unit">%</span>
                </div>
                <div class="metric">
                    <div class="metric-label">AMBIENT LIGHT</div>
                    <span id="lux" class="metric-value">--</span><span class="metric-unit">lux</span>
                </div>
            </div>
        </div>
    </section>

    <!-- HISTORY -->
    <section class="card" aria-labelledby="historyTitle">
        <div class="card-header">
            <div>
                <div class="card-title" id="historyTitle">Sample History</div>
                <div class="card-subtitle">Latest 10 samples with their photos</div>
            </div>
        </div>
        <div id="historyEmpty" class="empty">No samples yet</div>
        <div id="historyGrid" class="history-grid" hidden></div>
    </section>

    <!-- LIVE STREAM -->
    <section class="card" aria-labelledby="liveTitle">
        <div class="card-header">
            <div>
                <div class="card-title" id="liveTitle">Live Camera</div>
                <div class="card-subtitle" id="streamStatus" role="status">Connecting to camera...</div>
            </div>
            <button type="button" onclick="toggleStream()" id="streamButton" disabled>Start Stream</button>
        </div>
        <div class="image-container">
            <div id="streamMessage" class="image-message" role="status">Connecting to camera...</div>
            <img id="stream" alt="Live view from the rover camera" hidden>
        </div>
    </section>

    <!-- MANUAL CAPTURE -->
    <section class="card" aria-labelledby="captureTitle">
        <div class="card-header">
            <div>
                <div class="card-title" id="captureTitle">Capture Image</div>
                <div class="card-subtitle">Take a separate photo at any time</div>
            </div>
            <div class="actions">
                <button type="button" onclick="capturePhoto()" id="captureButton" disabled>Capture Image</button>
                <a id="downloadPhoto" class="download-button" hidden>Download JPEG</a>
            </div>
        </div>
        <div class="image-container">
            <div id="imageMessage" class="image-message" role="status">Select Capture Image to take a photo</div>
            <img id="photo" alt="Manually captured image" hidden>
        </div>
        <div id="captureInfo" class="info" role="status">
            Your latest photo will stay here until you take another one.
        </div>
    </section>

    <div class="footer">Project Sylvan · ATmega32A + ESP32-CAM</div>
</div>

<script>
let cameraAvailable = false;
let streamAvailable = false;
let streamPort = 81;
let streaming = false;
let captureInProgress = false;
let autoStartPending = true;
let streamCheck = null;
let photoUrl = null;

let renderedKey = '';
const sampleTimes = {};   // sample id -> browser time it was collected

function fmtAgo(ms)
{
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ' + (Math.floor(s / 60) % 60) + 'm ago';
}

function whenText(s)
{
    const at = new Date(sampleTimes[s.id]);
    return at.toLocaleTimeString() + ' · ' + fmtAgo(s.ago);
}

function sampleImageUrl(s, bootId)
{
    return '/sample.jpg?id=' + s.id + '&b=' + bootId;
}

/* =====================================================
   SAMPLES
   ===================================================== */

function renderSamples(data)
{
    const history = data.history || [];

    history.forEach(s => {
        if (!(s.id in sampleTimes)) sampleTimes[s.id] = Date.now() - s.ago;
    });

    const key = data.bootId + ':' + data.latestId;

    if (key !== renderedKey)
    {
        renderedKey = key;
        renderLatest(history[0], data.bootId);
        renderHistory(history, data.bootId);
    }

    // Refresh "x seconds ago" without reloading photos
    if (history[0])
        document.getElementById('latestWhen').textContent =
            'Sample #' + history[0].id + ' · ' + whenText(history[0]);

    history.forEach(s => {
        const el = document.getElementById('when-' + s.id);
        if (el) el.textContent = whenText(s);
    });
}

function renderLatest(s, bootId)
{
    const badge = document.getElementById('latestBadge');
    const photo = document.getElementById('latestPhoto');
    const message = document.getElementById('latestMessage');
    const download = document.getElementById('latestDownload');

    if (!s)
    {
        badge.hidden = true;
        photo.hidden = true;
        download.hidden = true;
        message.hidden = false;
        document.getElementById('latestWhen').textContent = 'No sample yet';
        return;
    }

    badge.hidden = false;
    badge.className = 'badge ' + (s.ok ? 'ok' : 'fail');
    badge.textContent = s.ok ? 'Sample OK' : 'Sample failed';

    document.getElementById('temperature').textContent = s.ok ? s.t.toFixed(1) : '--';
    document.getElementById('humidity').textContent = s.ok ? s.h.toFixed(1) : '--';
    document.getElementById('lux').textContent = s.ok ? Math.round(s.l) : '--';

    if (s.img)
    {
        const url = sampleImageUrl(s, bootId);
        photo.src = url;
        photo.hidden = false;
        message.hidden = true;
        download.href = url;
        download.download = 'sylvan-sample-' + s.id + '.jpg';
        download.hidden = false;
    }
    else
    {
        photo.hidden = true;
        photo.removeAttribute('src');
        download.hidden = true;
        message.hidden = false;
        message.textContent = 'No photo for this sample (camera unavailable)';
    }
}

function renderHistory(history, bootId)
{
    const grid = document.getElementById('historyGrid');
    const empty = document.getElementById('historyEmpty');

    if (history.length === 0)
    {
        grid.hidden = true;
        grid.innerHTML = '';
        empty.hidden = false;
        return;
    }

    empty.hidden = true;
    grid.hidden = false;

    grid.innerHTML = history.map(s => {
        const url = sampleImageUrl(s, bootId);
        const thumb = s.img
            ? '<img src="' + url + '" loading="lazy" alt="Photo for sample #' + s.id + '">'
            : '<span>No photo</span>';
        const reading = s.ok
            ? s.t.toFixed(1) + ' °C · ' + s.h.toFixed(1) + ' % · ' + Math.round(s.l) + ' lux'
            : 'Sensor read failed';
        const dl = s.img
            ? '<a class="download-button small" href="' + url +
              '" download="sylvan-sample-' + s.id + '.jpg">Download</a>'
            : '';

        return '<article class="sample">' +
            '<div class="thumb">' + thumb + '</div>' +
            '<div class="sample-body">' +
                '<div class="sample-top"><strong>#' + s.id + '</strong>' +
                '<span class="badge ' + (s.ok ? 'ok' : 'fail') + '">' +
                (s.ok ? 'OK' : 'Failed') + '</span></div>' +
                '<div class="sample-read">' + reading + '</div>' +
                '<div class="sample-when" id="when-' + s.id + '">' + whenText(s) + '</div>' +
                dl +
            '</div></article>';
    }).join('');
}

/* =====================================================
   STATUS POLLING
   ===================================================== */

async function updateStatus()
{
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try
    {
        const response = await fetch('/api/status', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Status request failed');
        const data = await response.json();

        const dot = document.getElementById('statusDot');
        const status = document.getElementById('connectionText');

        dot.className = 'status-dot ' + (data.seen ? 'online' : 'offline');
        status.textContent = !data.seen
            ? 'Waiting for first sample from the rover...'
            : 'Last packet ' + fmtAgo(data.ageMs) + ' · ' +
              data.samples + ' collected, ' + data.failed + ' failed';

        renderSamples(data);

        cameraAvailable = !!data.cameraReady;
        streamAvailable = !!data.streamReady;
        streamPort = data.streamPort || 81;
        document.getElementById('captureButton').disabled = !cameraAvailable || captureInProgress;
        document.getElementById('streamButton').disabled = !streamAvailable;

        if (!cameraAvailable)
        {
            stopStream('Camera unavailable. Check the board and restart it.');
        }
        else if (!streamAvailable)
        {
            stopStream('Live stream unavailable. Image capture is still available.');
        }
        else if (autoStartPending)
        {
            autoStartPending = false;
            startStream();
        }
    }
    catch (error)
    {
        document.getElementById('statusDot').className = 'status-dot offline';
        document.getElementById('connectionText').textContent =
            'Portal disconnected. Check your Wi-Fi connection.';
    }
    finally
    {
        clearTimeout(timeout);
        setTimeout(updateStatus, 1000);
    }
}

/* =====================================================
   LIVE STREAM
   ===================================================== */

function startStream()
{
    if (streaming || !streamAvailable) return;

    const img = document.getElementById('stream');
    const message = document.getElementById('streamMessage');
    const status = document.getElementById('streamStatus');
    const url = new URL('/stream', window.location.href);
    url.port = String(streamPort);
    url.searchParams.set('t', Date.now());

    streaming = true;
    message.hidden = false;
    message.textContent = 'Connecting to live camera...';
    status.textContent = 'Connecting...';
    document.getElementById('streamButton').textContent = 'Stop Stream';

    img.onerror = () => stopStream('Stream disconnected. Select Start Stream to retry.');
    img.hidden = false;
    img.src = url.href;

    const startedAt = Date.now();
    streamCheck = setInterval(() => {
        if (img.naturalWidth > 0)
        {
            message.hidden = true;
            status.textContent = 'Live · ' + img.naturalWidth + ' × ' + img.naturalHeight;
            clearInterval(streamCheck);
            streamCheck = null;
        }
        else if (Date.now() - startedAt > 15000)
        {
            stopStream('Stream timed out. Close other live viewers and try again.');
        }
    }, 250);
}

function stopStream(text = 'Stream stopped')
{
    streaming = false;
    clearInterval(streamCheck);
    streamCheck = null;
    const img = document.getElementById('stream');
    img.onerror = null;
    img.removeAttribute('src');
    img.hidden = true;
    document.getElementById('streamButton').textContent = 'Start Stream';
    document.getElementById('streamStatus').textContent = text;
    const message = document.getElementById('streamMessage');
    message.textContent = text;
    message.hidden = false;
}

function toggleStream()
{
    autoStartPending = false;
    if (streaming) stopStream();
    else startStream();
}

/* =====================================================
   MANUAL CAPTURE
   ===================================================== */

async function capturePhoto()
{
    if (captureInProgress || !cameraAvailable) return;

    const img = document.getElementById('photo');
    const message = document.getElementById('imageMessage');
    const button = document.getElementById('captureButton');
    const download = document.getElementById('downloadPhoto');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let nextUrl = null;

    captureInProgress = true;
    button.disabled = true;
    button.textContent = 'Capturing...';
    message.hidden = false;
    message.textContent = 'Capturing image...';

    try
    {
        const response = await fetch('/capture?t=' + Date.now(), { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(await response.text());
        const blob = await response.blob();
        if (blob.type !== 'image/jpeg' || !blob.size)
            throw new Error('Camera returned an invalid image');

        nextUrl = URL.createObjectURL(blob);
        const preview = new Image();
        preview.src = nextUrl;
        await preview.decode();

        const previousUrl = photoUrl;
        photoUrl = nextUrl;
        nextUrl = null;
        img.src = photoUrl;
        img.hidden = false;
        download.href = photoUrl;
        download.download = 'sylvan-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jpg';
        download.hidden = false;
        message.hidden = true;
        document.getElementById('captureInfo').textContent =
            'Captured ' + new Date().toLocaleString() + ' · ' +
            preview.naturalWidth + ' × ' + preview.naturalHeight + ' · ' +
            Math.round(blob.size / 1024) + ' KB';
        if (previousUrl) URL.revokeObjectURL(previousUrl);
    }
    catch (error)
    {
        message.textContent = error.name === 'AbortError'
            ? 'Capture timed out. Please try again.'
            : 'Capture failed: ' + error.message;
    }
    finally
    {
        if (nextUrl) URL.revokeObjectURL(nextUrl);
        clearTimeout(timeout);
        captureInProgress = false;
        button.disabled = !cameraAvailable;
        button.textContent = 'Capture Image';
    }
}

window.addEventListener('pagehide', () => stopStream());
updateStatus();
</script>
</body>
</html>
)rawliteral";


// =====================================================
// HTTP HANDLERS (port 80)
// =====================================================

void handleHome()
{
    server.send_P(200, "text/html", INDEX_HTML);
}

void handleStatus()
{
    unsigned long now = millis();
    unsigned long age = atmegaSeen ? now - lastAtmegaPacket : 0;

    String json;
    json.reserve(1600);

    json = "{";
    json += "\"seen\":";         json += atmegaSeen ? "true" : "false";
    json += ",\"samples\":";     json += String(sampleCount);
    json += ",\"failed\":";      json += String(failedCount);
    json += ",\"latestId\":";    json += String(nextSampleId - 1);
    json += ",\"bootId\":";      json += String(bootId);
    json += ",\"ageMs\":";       json += String(age);
    json += ",\"cameraReady\":"; json += cameraReady ? "true" : "false";
    json += ",\"streamReady\":"; json += streamReady ? "true" : "false";
    json += ",\"streamPort\":";  json += String(STREAM_PORT);

    json += ",\"history\":[";
    for (uint8_t i = 0; i < historyCount; i++)
    {
        // newest first
        uint8_t idx = (historyHead + HISTORY_SIZE - 1 - i) % HISTORY_SIZE;
        const SampleRecord &r = sampleHistory[idx];

        if (i > 0)
            json += ",";

        json += "{\"id\":";  json += String(r.id);
        json += ",\"ok\":";  json += r.ok ? "true" : "false";
        json += ",\"t\":";   json += String(r.t, 1);
        json += ",\"h\":";   json += String(r.h, 1);
        json += ",\"l\":";   json += String(r.l, 0);
        json += ",\"ago\":"; json += String(now - r.atMs);
        json += ",\"img\":"; json += r.jpg ? "true" : "false";
        json += "}";
    }
    json += "]}";

    server.sendHeader("Cache-Control", "no-store");
    server.send(200, "application/json", json);
}

void handleSampleImage()
{
    if (!server.hasArg("id"))
    {
        server.send(400, "text/plain", "Missing id");
        return;
    }

    uint32_t id = strtoul(server.arg("id").c_str(), nullptr, 10);

    for (uint8_t i = 0; i < HISTORY_SIZE; i++)
    {
        const SampleRecord &r = sampleHistory[i];

        if (r.jpg != nullptr && r.id == id)
        {
            // Sample photos never change; the boot id in the URL keeps this safe.
            server.sendHeader("Cache-Control", "public, max-age=86400");
            server.setContentLength(r.jpgLen);
            server.send(200, "image/jpeg", "");
            server.sendContent((const char *)r.jpg, r.jpgLen);
            return;
        }
    }

    server.send(404, "text/plain", "Photo no longer available");
}

void handleCapture()
{
    Serial.println("Taking manual image...");

    if (!cameraReady)
    {
        server.send(503, "text/plain", "Camera is not ready");
        return;
    }

    uint8_t *jpg = nullptr;
    size_t jpgLen = 0;

    if (!captureJpeg(CAPTURE_JPEG_QUALITY, &jpg, &jpgLen,
                     pdMS_TO_TICKS(5000)))
    {
        Serial.println("ERROR: Camera capture / JPEG conversion failed!");
        server.send(500, "text/plain", "Camera capture failed");
        return;
    }

    Serial.printf("JPEG image: %u bytes\n", (unsigned int)jpgLen);

    server.sendHeader("Cache-Control", "no-store");
    server.setContentLength(jpgLen);
    server.send(200, "image/jpeg", "");
    server.sendContent((const char *)jpg, jpgLen);

    free(jpg);
}

void handleNotFound()
{
    server.send(404, "text/plain", "Not found");
}


// =====================================================
// SETUP
// =====================================================

void setup()
{
    Serial.begin(115200);
    delay(2000);

    bootId = esp_random();

    Serial.println();
    Serial.println("================================");
    Serial.println("       PROJECT SYLVAN");
    Serial.println("================================");

    // ---------- ATmega UART ----------
    AtmegaSerial.begin(ATMEGA_BAUD, SERIAL_8N1, ATMEGA_RX_PIN, ATMEGA_TX_PIN);
    Serial.printf("ATmega UART RX = GPIO%d, TX = GPIO%d @ %d baud\n",
                  ATMEGA_RX_PIN, ATMEGA_TX_PIN, ATMEGA_BAUD);

    // ---------- Flash LED off ----------
    pinMode(FLASH_LED_GPIO, OUTPUT);
    digitalWrite(FLASH_LED_GPIO, LOW);

    // ---------- Camera ----------
    cameraMutex = xSemaphoreCreateMutex();

    if (initCamera())
        cameraReady = true;
    else
        Serial.println("Camera failed. Portal will run without photos.");

    // ---------- Wi-Fi (station mode: join the home network) ----------
    Serial.printf("Connecting to Wi-Fi \"%s\"...\n", WIFI_SSID);

    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);   // a sleeping radio would delay/queue every upload
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    unsigned long wifiStart = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 20000)
    {
        delay(300);
        Serial.print(".");
    }
    Serial.println();

    if (WiFi.status() != WL_CONNECTED)
    {
        // Keep going rather than halt: the local portal/stream/UART/photo history still work
        // without the internet, and the retry inside uploadSampleToServer() covers a Wi-Fi
        // blip that clears up shortly after boot. WiFi.begin() above keeps trying in the
        // background, so a later sample can still succeed once the network is reachable.
        Serial.println("WARNING: Wi-Fi did not connect within 20s. Uploads will be skipped");
        Serial.println("until it does; the local portal/photos keep working regardless.");
    }
    else
    {
        Serial.println("================================");
        Serial.print("Wi-Fi:   "); Serial.println(WIFI_SSID);
        Serial.print("IP:      "); Serial.println(WiFi.localIP());
        Serial.printf("Portal:  http://%s\n", WiFi.localIP().toString().c_str());
        Serial.printf("Stream:  http://%s:%u/stream\n",
                      WiFi.localIP().toString().c_str(), STREAM_PORT);
        Serial.print("Uploads: https://"); Serial.print(SERVER_HOST); Serial.println(UPLOAD_PATH);
        Serial.println("================================");

        // TLS certificate validation checks the current date, and the ESP32's clock starts
        // at 1970-01-01 on every boot — sync it before the first upload or every HTTPS
        // request will fail with a certificate error that has nothing to do with the cert.
        Serial.print("Syncing time via NTP");
        configTime(0, 0, "pool.ntp.org", "time.google.com");
        time_t now = time(nullptr);
        unsigned long ntpStart = millis();
        while (now < 1700000000 && millis() - ntpStart < 15000)   // before 2023 = not synced yet
        {
            delay(300);
            Serial.print(".");
            now = time(nullptr);
        }
        Serial.println();
        if (now < 1700000000)
            Serial.println("WARNING: NTP sync failed; HTTPS uploads will likely fail until it syncs.");
        else
            Serial.printf("Time synced: %s", ctime(&now));
    }

    // ---------- Live view WebSocket (/ws/device) ----------
    // Configured once, unconditionally: the library's own loop() handles connecting (and
    // reconnecting) whenever Wi-Fi and NTP time are actually ready, so this stays correct
    // even if the Wi-Fi connect attempt above hasn't succeeded yet.
    {
        String wsHeaders = String("X-Device-Key: ") + DEVICE_KEY;
        wsDevice.setExtraHeaders(wsHeaders.c_str());
        wsDevice.onEvent(onWsDeviceEvent);
        wsDevice.beginSslWithCA(SERVER_HOST, SERVER_PORT, DEVICE_WS_PATH, ROOT_CA_ISRG_X1);
        wsDevice.setReconnectInterval(5000);
        Serial.print("Live view: wss://"); Serial.print(SERVER_HOST); Serial.println(DEVICE_WS_PATH);
    }

    // ---------- Live stream server (port 81) ----------
    if (cameraReady)
        streamReady = startStreamServer();

    // ---------- Portal server (port 80) ----------
    server.on("/", HTTP_GET, handleHome);
    server.on("/api/status", HTTP_GET, handleStatus);
    server.on("/capture", HTTP_GET, handleCapture);
    server.on("/sample.jpg", HTTP_GET, handleSampleImage);
    server.onNotFound(handleNotFound);
    server.begin();

    Serial.println("Web server started. Waiting for rover samples...");
}


// =====================================================
// LOOP
// =====================================================

void loop()
{
    readAtmegaUART();
    server.handleClient();
    wsDevice.loop();
    sendLiveHeartbeatIfDue();
    sendLiveFrameIfDue();
    delay(2);
}
