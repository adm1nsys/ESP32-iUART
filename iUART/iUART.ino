// iUART — a wireless serial console: read and type into any device's UART from a browser
// (Arduino, Linux boards, routers, other microcontrollers…).
// Runs on ESP32 (WROOM-32, two ports) and Seeed XIAO ESP32-C6 (one port).
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <HardwareSerial.h>

#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif
#include "web_ui.h"

// ---------- serial ports ----------

struct Port {
  const char* name;
  HardwareSerial* serial;
  int rx;
  int tx;
};

#if CONFIG_IDF_TARGET_ESP32C6
#define BOARD_NAME "XIAO ESP32-C6"
HardwareSerial Uart1(1);
Port ports[] = {{"UART1", &Uart1, 17, 16}};  // D7 = RX, D6 = TX
#else
#define BOARD_NAME "ESP32 WROOM-32"
HardwareSerial Uart1(1);
HardwareSerial Uart2(2);
Port ports[] = {{"UART1", &Uart1, 16, 17}, {"UART2", &Uart2, 25, 26}};
#endif

const size_t PORT_COUNT = sizeof(ports) / sizeof(ports[0]);
size_t activePort = 0;
uint32_t baud = DEFAULT_BAUD;

// ---------- log ring buffer ----------
// Every received byte gets a sequence number; the page asks for "everything after N".

const size_t LOG_SIZE = 32 * 1024;
char logBuf[LOG_SIZE];
uint32_t logTotal = 0;   // bytes written since boot
uint32_t mutedLines = 0;  // lines from MUTED_LINES that were counted instead of shown

void logWrite(const char* data, size_t len) {
  for (size_t i = 0; i < len; i++) logBuf[(logTotal + i) % LOG_SIZE] = data[i];
  logTotal += len;
}

WebServer server(80);
bool apMode = false;

// ---------- Wi-Fi ----------

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(HOSTNAME);
  for (const WifiNetwork& net : WIFI_NETWORKS) {
    if (net.ip != IPAddress(0, 0, 0, 0)) WiFi.config(net.ip, net.gateway, net.subnet, net.gateway);
    WiFi.begin(net.ssid, net.password);
    Serial.printf("Connecting to %s", net.ssid);
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) { delay(250); Serial.print('.'); }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("Connected: http://%s  (http://%s.local)\n", WiFi.localIP().toString().c_str(), HOSTNAME);
      return;
    }
    WiFi.disconnect(true);
  }
  // no known network: open our own access point
  apMode = true;
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  Serial.printf("Access point \"%s\" ready: http://%s\n", AP_SSID, WiFi.softAPIP().toString().c_str());
}

// ---------- HTTP ----------

void sendGz(const char* type, const uint8_t* data, size_t len) {
  server.sendHeader("Content-Encoding", "gzip");
  server.sendHeader("Cache-Control", "no-cache");
  server.send_P(200, type, reinterpret_cast<const char*>(data), len);
}

String statusJson() {
  String ports_json;
  for (size_t i = 0; i < PORT_COUNT; i++) {
    if (i) ports_json += ',';
    ports_json += '"'; ports_json += ports[i].name; ports_json += '"';
  }
  String ip = apMode ? WiFi.softAPIP().toString() : WiFi.localIP().toString();
  String ssid = apMode ? String(AP_SSID) : WiFi.SSID();
  ssid.replace("\"", "'");
  return String("{\"board\":\"") + BOARD_NAME + "\",\"uarts\":[" + ports_json + "],\"uart\":\"" + ports[activePort].name +
         "\",\"baud\":" + baud + ",\"ip\":\"" + ip + "\",\"mode\":\"" + (apMode ? "ap" : "sta") + "\",\"ssid\":\"" + ssid +
         "\",\"rssi\":" + (apMode ? 0 : WiFi.RSSI()) + ",\"uptime\":" + (millis() / 1000) + ",\"muted\":" + mutedLines + "}";
}

void handleLogs() {
  uint32_t since = server.hasArg("since") ? strtoul(server.arg("since").c_str(), nullptr, 10) : 0;
  bool reset = false;
  if (since > logTotal) { since = 0; reset = true; }                  // the board restarted
  if (logTotal - since > LOG_SIZE) { since = logTotal - LOG_SIZE; reset = true; }  // older bytes are gone
  size_t len = min<size_t>(logTotal - since, 8192);                   // keep responses small
  String body;
  body.reserve(len);
  for (size_t i = 0; i < len; i++) body += logBuf[(since + i) % LOG_SIZE];
  server.sendHeader("X-Seq", String(since + len));
  server.sendHeader("X-Reset", reset ? "1" : "0");
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "text/plain; charset=utf-8", body);
}

void handleSend() {
  const String& data = server.arg("plain");
  ports[activePort].serial->print(data);
  server.send(204);
}

void handleUart() {
  String name = server.arg("name");
  for (size_t i = 0; i < PORT_COUNT; i++) {
    if (name == ports[i].name) {
      activePort = i;
      server.send(200, "application/json", statusJson());
      return;
    }
  }
  server.send(400, "text/plain", "unknown port");
}

void handleBaud() {
  uint32_t value = strtoul(server.arg("value").c_str(), nullptr, 10);
  if (value < 300 || value > 2000000) { server.send(400, "text/plain", "invalid baud"); return; }
  baud = value;
  for (size_t i = 0; i < PORT_COUNT; i++) ports[i].serial->updateBaudRate(baud);
  server.send(200, "application/json", statusJson());
}

void setupServer() {
  server.on("/", HTTP_GET, [] { sendGz("text/html", INDEX_HTML_GZ, INDEX_HTML_GZ_LEN); });
  server.on("/style.css", HTTP_GET, [] { sendGz("text/css", STYLE_CSS_GZ, STYLE_CSS_GZ_LEN); });
  server.on("/app.js", HTTP_GET, [] { sendGz("application/javascript", APP_JS_GZ, APP_JS_GZ_LEN); });
  server.on("/api/status", HTTP_GET, [] { server.send(200, "application/json", statusJson()); });
  server.on("/api/logs", HTTP_GET, handleLogs);
  server.on("/api/send", HTTP_POST, handleSend);
  server.on("/api/uart", HTTP_POST, handleUart);
  server.on("/api/baud", HTTP_POST, handleBaud);
  server.on("/api/clear", HTTP_POST, [] { logTotal = 0; mutedLines = 0; server.send(204); });
  server.onNotFound([] { server.send(404, "text/plain", "not found"); });
  server.begin();
}

// ---------- main ----------

void setup() {
  Serial.begin(115200);
  for (size_t i = 0; i < PORT_COUNT; i++) {
    ports[i].serial->setRxBufferSize(4096);
    ports[i].serial->begin(baud, SERIAL_8N1, ports[i].rx, ports[i].tx);
  }
  connectWifi();
  if (MDNS.begin(HOSTNAME)) MDNS.addService("http", "tcp", 80);
  setupServer();
}

void loop() {
  server.handleClient();

  HardwareSerial* serial = ports[activePort].serial;
  int available = serial->available();
  if (available <= 0) return;

  char chunk[512];
  size_t len = serial->readBytes(chunk, min<int>(available, sizeof(chunk)));
  // chatty lines (see MUTED_LINES in config) are counted instead of flooding the screen
  for (const char* muted : MUTED_LINES) {
    size_t mlen = strlen(muted);
    if (mlen && len <= mlen + 4 && memmem(chunk, len, muted, mlen)) {
      mutedLines++;
      return;
    }
  }
  logWrite(chunk, len);
}
