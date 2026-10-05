// Sentinel-X Edge Node : ESP8266 NodeMCU
// Capteurs : DHT22, MQ-2 (A0), PIR. Sortie : OLED, buzzer actif, LED bicolore.
// Liaison : MQTT sur TLS (8883) vers le PC serveur.
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <WiFiClientSecure.h>
#include <time.h>

#include "certs.h"   // genere par security/setup.sh (CA_CERT)
#include "config.h"  // genere par security/setup.sh (WIFI_*, MQTT_*)

// Brochage NodeMCU (modifiable ici)
#define PIN_DHT D5       // GPIO14
#define PIN_PIR D6       // GPIO12
#define PIN_BUZZER D7    // GPIO13
#define PIN_LED_RED D8   // GPIO15 (anode via resistance, cathode au GND)
#define PIN_LED_GREEN D0 // GPIO16
// MQ-2 sur A0 ; OLED I2C : SDA=D2 (GPIO4), SCL=D1 (GPIO5)

#define TOPIC_TELEMETRY "sentinel/telemetry"
#define TOPIC_CMD "sentinel/cmd"
#define SEND_INTERVAL_MS 2000

DHT dht(PIN_DHT, DHT22);
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
BearSSL::WiFiClientSecure tlsClient;
BearSSL::X509List caList(CA_CERT);
PubSubClient mqtt(tlsClient);

unsigned long lastSend = 0;
bool lastMotion = false;

void setLed(const String &color) {
  digitalWrite(PIN_LED_RED, color == "red");
  digitalWrite(PIN_LED_GREEN, color == "green");
}

void drawStatus(float t, float h, int gas, bool motion) {
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 0);
  oled.println("SENTINEL-X");
  oled.print("IP: ");
  oled.println(WiFi.localIP());
  oled.print("WiFi:");
  oled.print(WiFi.status() == WL_CONNECTED ? "OK " : "KO ");
  oled.print("MQTT:");
  oled.println(mqtt.connected() ? "OK" : "KO");
  oled.printf("T:%.1fC H:%.0f%%\n", t, h);
  oled.printf("Gaz:%d Mvt:%s\n", gas, motion ? "OUI" : "non");
  oled.display();
}

void onCommand(char *topic, byte *payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;
  if (doc["buzzer"].is<bool>()) digitalWrite(PIN_BUZZER, doc["buzzer"].as<bool>());
  if (doc["led"].is<const char *>()) setLed(doc["led"].as<String>());
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(300);
  // TLS : le certificat n'est valide que si l'horloge est a l'heure
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  while (time(nullptr) < 1700000000) delay(300);
}

void connectMqtt() {
  while (!mqtt.connected()) {
    if (mqtt.connect("sentinel-esp", MQTT_USER, MQTT_PASSWORD)) {
      mqtt.subscribe(TOPIC_CMD, 1);
    } else {
      Serial.printf("MQTT KO rc=%d tls=%d\n", mqtt.state(), tlsClient.getLastSSLError());
      delay(2000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_PIR, INPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  setLed("green");
  dht.begin();
  oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  oled.clearDisplay();
  oled.println("Connexion WiFi...");
  oled.display();

  connectWifi();
  tlsClient.setTrustAnchors(&caList);  // verifie le certificat du serveur (pas de setInsecure)
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onCommand);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWifi();
  if (!mqtt.connected()) connectMqtt();
  mqtt.loop();

  if (millis() - lastSend < SEND_INTERVAL_MS) return;
  lastSend = millis();

  float t = dht.readTemperature(), h = dht.readHumidity();
  if (isnan(t) || isnan(h)) return;  // lecture DHT ratee : on saute
  int gas = analogRead(A0);
  bool motion = digitalRead(PIN_PIR);

  JsonDocument doc;
  doc["temp"] = t;
  doc["hum"] = h;
  doc["gas"] = gas;
  doc["motion"] = motion ? 1 : 0;
  doc["motion_edge"] = (motion && !lastMotion) ? 1 : 0;
  lastMotion = motion;
  char buf[160];
  size_t n = serializeJson(doc, buf);
  mqtt.publish(TOPIC_TELEMETRY, (const uint8_t *)buf, n);
  drawStatus(t, h, gas, motion);
}
