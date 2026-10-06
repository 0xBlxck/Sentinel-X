// Sentinel-X Edge Node : ESP8266 NodeMCU
// Capteurs : DHT22, MQ-2 (A0), PIR. Sortie : OLED, buzzer actif, LED bicolore.
// Liaison : MQTT sur TLS (8883) vers le PC serveur, ou pont USB (env bridge) :
// mesures envoyees sur le port serie, commandes JSON recues ligne par ligne.
// Les capteurs, l'OLED et le port serie fonctionnent meme sans reseau :
// la connexion Wi-Fi/NTP/MQTT se fait en arriere-plan, sans bloquer la boucle.
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
// Buzzer actif 2 pattes : + sur D7, - sur GND (sonne quand D7 est a 3,3 V).
// Pour un module 3 broches actif a l'etat bas (sonne a 0 V), compiler avec -DBUZZER_ACTIVE_LOW.
#ifdef BUZZER_ACTIVE_LOW
#define BUZZER_ON LOW
#define BUZZER_OFF HIGH
#else
#define BUZZER_ON HIGH
#define BUZZER_OFF LOW
#endif
#define PIN_LED_RED D8   // GPIO15 (anode via resistance, cathode au GND)
#define PIN_LED_GREEN D0 // GPIO16
// MQ-2 sur A0 ; OLED I2C : SDA=D2 (GPIO4), SCL=D1 (GPIO5)

#define TOPIC_TELEMETRY "sentinel/telemetry"
#define TOPIC_CMD "sentinel/cmd"
#define SEND_INTERVAL_MS 2000
#define NET_RETRY_MS 5000
#define TIME_VALID 1700000000

DHT dht(PIN_DHT, DHT22);
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
BearSSL::WiFiClientSecure tlsClient;
BearSSL::X509List caList(CA_CERT);
PubSubClient mqtt(tlsClient);

unsigned long lastSend = 0, lastNet = 0;
bool lastMotion = false;
bool oledOk = false;
bool wifiStarted = false;
bool ntpStarted = false;
float lastT = NAN, lastH = NAN;

bool buzzerOn = false;
String ledState = "off";  // GPIO16 (D0) se relit mal : on memorise l'etat demande

void setLed(const String &color) {
  ledState = color == "red" || color == "green" ? color : "off";
  digitalWrite(PIN_LED_RED, color == "red");
  digitalWrite(PIN_LED_GREEN, color == "green");
}

void drawStatus(float t, float h, int gas, bool motion) {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 0);
  oled.println("SENTINEL-X");
#ifdef SERIAL_BRIDGE
  oled.println("Liaison: USB (pont)");
  oled.println("MQTTS via le PC");
#else
  oled.print("IP: ");
  oled.println(WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : String("-"));
  oled.print("WiFi:");
  oled.print(WiFi.status() == WL_CONNECTED ? "OK " : "KO ");
  oled.print("MQTT:");
  oled.println(mqtt.connected() ? "OK" : "KO");
#endif
  if (isnan(t) || isnan(h)) {
    oled.println("DHT22: pas de lecture");
  } else {
    oled.printf("T:%.1fC H:%.0f%%\n", t, h);
  }
  oled.printf("Gaz:%d Mvt:%s\n", gas, motion ? "OUI" : "non");
  oled.display();
}

void onCommand(char *topic, byte *payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;
  if (doc["buzzer"].is<bool>()) {
    buzzerOn = doc["buzzer"].as<bool>();
    digitalWrite(PIN_BUZZER, buzzerOn ? BUZZER_ON : BUZZER_OFF);
  }
  if (doc["led"].is<const char *>()) setLed(doc["led"].as<String>());
  Serial.printf("[cmd] buzzer=%d led=%s\n", buzzerOn,
                ledState.c_str());
}

#ifdef SERIAL_BRIDGE
// Pont USB : le PC renvoie les commandes du broker sous forme d'une ligne JSON.
void serialCommands() {
  static char line[128];
  static size_t len = 0;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      if (len) onCommand(nullptr, (byte *)line, len);
      len = 0;
    } else if (c != '\r' && len < sizeof(line) - 1) {
      line[len++] = c;
    }
  }
}
#endif

// Un pas de connexion reseau, jamais bloquant plus de quelques secondes.
void networkStep() {
#ifdef SERIAL_BRIDGE
  return;  // mode pont USB : pas de reseau, les mesures partent par le port serie
#endif
  if (millis() - lastNet < NET_RETRY_MS) return;
  lastNet = millis();

  if (WiFi.status() != WL_CONNECTED) {
    static unsigned long lastBegin = 0;
    if (wifiStarted && millis() - lastBegin < 15000) {
      Serial.printf("[wifi] en cours (status=%d, 1=reseau introuvable, 6=mauvais mot de passe)\n",
                    WiFi.status());
      return;
    }
    lastBegin = millis();
    // Nouvelle tentative propre toutes les 15 s (l'auto-reconnect reste parfois bloque en status 7)
    WiFi.persistent(false);
    WiFi.disconnect(true);
    WiFi.mode(WIFI_STA);
    WiFi.setPhyMode(WIFI_PHY_MODE_11G);  // plus tolerant avec les hotspots Windows
    WiFi.setSleepMode(WIFI_NONE_SLEEP);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    wifiStarted = true;
    Serial.printf("[wifi] connexion a '%s'...\n", WIFI_SSID);
    return;
  }

  // TLS : le certificat n'est valide que si l'horloge est a l'heure
  if (!ntpStarted) {
    Serial.printf("[wifi] OK ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    ntpStarted = true;
  }
  if (time(nullptr) < TIME_VALID) {
    Serial.println("[ntp] en attente de l'heure (internet sur le hotspot ?)");
    return;
  }

  if (!mqtt.connected()) {
    Serial.printf("[mqtt] connexion a %s:%d...\n", MQTT_HOST, MQTT_PORT);
    if (mqtt.connect("sentinel-esp", MQTT_USER, MQTT_PASSWORD)) {
      Serial.println("[mqtt] OK");
      mqtt.subscribe(TOPIC_CMD, 1);
    } else {
      Serial.printf("[mqtt] KO rc=%d tls=%d\n", mqtt.state(), tlsClient.getLastSSLError());
      // Diagnostic : le serveur est-il joignable en TCP simple ?
      WiFiClient probe;
      probe.setTimeout(3000);
      Serial.printf("[diag] gw=%s mask=%s tcp %s:%d -> %s\n", WiFi.gatewayIP().toString().c_str(),
                    WiFi.subnetMask().toString().c_str(), MQTT_HOST, MQTT_PORT,
                    probe.connect(MQTT_HOST, MQTT_PORT) ? "OK" : "ECHEC");
      probe.stop();
    }
  }
}

void setup() {
  // En tout premier : buzzer a l'arret (niveau ecrit avant de passer la broche en sortie)
  digitalWrite(PIN_BUZZER, BUZZER_OFF);
  pinMode(PIN_BUZZER, OUTPUT);
  Serial.begin(115200);
  pinMode(PIN_PIR, INPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  setLed("green");
  dht.begin();
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  Serial.printf("\n[boot] OLED %s, redemarrage : %s\n", oledOk ? "OK" : "introuvable (0x3C)",
                ESP.getResetReason().c_str());

  tlsClient.setTrustAnchors(&caList);  // verifie le certificat du serveur (pas de setInsecure)
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onCommand);
  // Hotspot de telephone : latence irreguliere (pics > 250 ms), on tolere plus de silence
  mqtt.setKeepAlive(30);
  mqtt.setSocketTimeout(10);
}

void loop() {
#ifdef SERIAL_BRIDGE
  serialCommands();
#endif
  networkStep();
  if (mqtt.connected()) mqtt.loop();

  if (millis() - lastSend < SEND_INTERVAL_MS) return;
  lastSend = millis();

  float t = dht.readTemperature(), h = dht.readHumidity();
  int gas = analogRead(A0);
  bool motion = digitalRead(PIN_PIR);
  bool dhtOk = !(isnan(t) || isnan(h));
  if (dhtOk) {
    lastT = t;
    lastH = h;
    Serial.printf("[capteurs] T=%.1fC H=%.1f%% gaz=%d mvt=%d\n", t, h, gas, motion);
  } else {
    Serial.printf("[capteurs] DHT22 sans reponse (verifier D5, 3V, GND) gaz=%d mvt=%d\n", gas, motion);
  }
  drawStatus(lastT, lastH, gas, motion);

  bool edge = motion && !lastMotion;
  lastMotion = motion;
  if (!dhtOk || !mqtt.connected()) return;  // on n'envoie que des mesures valides

  JsonDocument doc;
  doc["temp"] = t;
  doc["hum"] = h;
  doc["gas"] = gas;
  doc["motion"] = motion ? 1 : 0;
  doc["motion_edge"] = edge ? 1 : 0;
  char buf[160];
  size_t n = serializeJson(doc, buf);
  bool sent = mqtt.publish(TOPIC_TELEMETRY, (const uint8_t *)buf, n);
  Serial.printf("[mqtt] publish %s\n", sent ? "OK" : "ECHEC");
}
