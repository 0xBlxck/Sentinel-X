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
// MQ-2 sur A0 (via diviseur) ; OLED I2C sur les broches I2C par defaut
#define PIN_SDA D2  // GPIO4
#define PIN_SCL D1  // GPIO5

#define TOPIC_TELEMETRY "sentinel/telemetry"
#define TOPIC_CMD "sentinel/cmd"
#define TOPIC_STATE "sentinel/state"  // etat reel des actionneurs (retenu), publie apres chaque commande
#define SEND_INTERVAL_MS 2000
// MQ-2 : la resistance chauffante doit atteindre sa temperature avant des mesures fiables.
// Seuil sur la valeur brute de A0 (air propre ~50, fumee franche > 400) : l'ESP sonne seul,
// meme sans reseau. Hysteresis pour ne pas osciller autour du seuil.
#define GAS_WARMUP_MS 120000
#define GAS_ALARM_ON 300
#define GAS_ALARM_OFF 250
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

bool buzzerOn = false;    // alarme commandee par le serveur (boucle)
bool gasAlarm = false;    // alarme gaz locale, independante du serveur
bool gasEdge = false;     // declenchement a signaler au serveur au prochain envoi
bool statePending = true; // etat des actionneurs a (re)publier sur TOPIC_STATE
String ledState = "off";  // GPIO16 (D0) se relit mal : on memorise l'etat demande

bool gasWarming() { return millis() < GAS_WARMUP_MS; }

// ---------- Sonneries ----------
// Buzzer actif : une seule note, on joue donc sur le rythme. Chaque sonnerie est une suite
// de durees en ms alternant son / silence, jouee sans bloquer la boucle (capteurs, reseau).
const uint16_t TUNE_ALARM[] = {90, 60, 90, 60, 90, 60, 90, 60, 550, 350};  // 4 bips rapides + note longue
const uint16_t TUNE_ACCESS[] = {45, 45, 45, 45, 160};                      // gazouillis "acces autorise"
const uint16_t TUNE_BEEP[] = {150};                                        // bip de test
const uint16_t TUNE_GAS[] = {250, 250};                                    // bips reguliers "evacuez"
const uint16_t *tune = nullptr;
uint8_t tuneLen = 0, tuneStep = 0;
bool tuneLoop = false;
unsigned long tuneAt = 0;

void play(const uint16_t *steps, uint8_t len, bool loop) {
  tune = steps;
  tuneLen = len;
  tuneLoop = loop;
  tuneStep = 0;
  tuneAt = millis();
  digitalWrite(PIN_BUZZER, BUZZER_ON);  // les pas pairs sont sonores
}

void stopTune() {
  tune = nullptr;
  digitalWrite(PIN_BUZZER, BUZZER_OFF);
}

// Sonnerie de fond selon les alarmes actives (le gaz passe avant l'intrusion), sinon silence.
void resumeAlarm() {
  if (gasAlarm) play(TUNE_GAS, sizeof(TUNE_GAS) / 2, true);
  else if (buzzerOn) play(TUNE_ALARM, sizeof(TUNE_ALARM) / 2, true);
  else stopTune();
}

void tuneTick() {
  if (!tune || millis() - tuneAt < tune[tuneStep]) return;
  tuneAt = millis();
  if (++tuneStep >= tuneLen) {
    if (!tuneLoop) {
      resumeAlarm();  // une sonnerie courte jouee pendant une alarme lui rend la main
      return;
    }
    tuneStep = 0;
  }
  digitalWrite(PIN_BUZZER, tuneStep % 2 == 0 ? BUZZER_ON : BUZZER_OFF);
}

void setLed(const String &color) {
  ledState = color == "red" || color == "green" ? color : "off";
  digitalWrite(PIN_LED_RED, color == "red");
  digitalWrite(PIN_LED_GREEN, color == "green");
}

// ---------- Ecran OLED 128x64 ----------
// 4 ecrans : normal (mesures), alarme (clignotant tant que le buzzer sonne),
// inconnu (le PIR voit bouger et la camera n'a pas reconnu la personne),
// accueil (prenom de la personne reconnue par la camera, quelques secondes).
#define STRANGER_HOLD_MS 15000  // validite d'un signalement "non reconnu" de la camera
int curGas = 0;
bool curMotion = false;
String welcomeName;
unsigned long welcomeUntil = 0, strangerUntil = 0, lastOled = 0;

void centerText(const String &s, int y, int size) {
  oled.setTextSize(size);
  oled.setCursor((128 - (int)s.length() * 6 * size) / 2, y);
  oled.print(s);
}

void drawHeader() {
  oled.fillRect(0, 0, 128, 12, SSD1306_WHITE);
  oled.setTextColor(SSD1306_BLACK);
  oled.setTextSize(1);
  oled.setCursor(3, 2);
  oled.print("SENTINEL-X");
#ifdef SERIAL_BRIDGE
  oled.setCursor(106, 2);
  oled.print("USB");
#else
  long rssi = WiFi.RSSI();
  int bars = WiFi.status() != WL_CONNECTED ? 0 : rssi > -55 ? 4 : rssi > -65 ? 3 : rssi > -75 ? 2 : 1;
  for (int i = 0; i < 4; i++) {  // force du Wi-Fi
    int h = 3 + i * 2;
    if (i < bars) oled.fillRect(98 + i * 4, 10 - h, 3, h, SSD1306_BLACK);
    else oled.drawPixel(99 + i * 4, 9, SSD1306_BLACK);
  }
  // pastille MQTT : pleine = session chiffree active
  if (mqtt.connected()) oled.fillCircle(121, 6, 3, SSD1306_BLACK);
  else oled.drawCircle(121, 6, 3, SSD1306_BLACK);
#endif
  oled.setTextColor(SSD1306_WHITE);
}

void drawNormal() {
  drawHeader();
  // temperature (gauche) et humidite (droite) en grand
  oled.setTextSize(2);
  oled.setCursor(0, 17);
  if (isnan(lastT)) oled.print("--.-");
  else oled.printf("%.1f", lastT);
  int x = oled.getCursorX();
  oled.drawCircle(x + 3, 19, 2, SSD1306_WHITE);  // symbole degre
  oled.setTextSize(1);
  oled.setCursor(x + 7, 17);
  oled.print("C");
  String hum = isnan(lastH) ? String("--%") : String((int)round(lastH)) + "%";
  oled.setTextSize(2);
  oled.setCursor(128 - hum.length() * 12, 17);
  oled.print(hum);
  oled.setTextSize(1);
  oled.setCursor(0, 35);
  oled.print("TEMP");
  oled.setCursor(128 - 8 * 6, 35);
  oled.print("HUMIDITE");
  oled.drawFastHLine(0, 45, 128, SSD1306_WHITE);
  // gaz et presence
  oled.setCursor(0, 48);
  if (gasWarming()) oled.printf("GAZ chauffe %lus", (GAS_WARMUP_MS - millis()) / 1000);
  else oled.printf("GAZ %d", curGas);
  if (curMotion) {
    oled.fillRect(84, 47, 44, 9, SSD1306_WHITE);
    oled.setTextColor(SSD1306_BLACK);
  }
  oled.setCursor(curMotion ? 87 : 90, 48);
  oled.print(curMotion ? "PRESENCE" : "R.A.S.");
  oled.setTextColor(SSD1306_WHITE);
  // adresse du boitier
  oled.setCursor(0, 57);
#ifdef SERIAL_BRIDGE
  oled.print("liaison USB -> PC");
#else
  oled.print(WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : String("wifi..."));
#endif
}

void drawAlarm() {
  oled.drawRect(0, 0, 128, 64, SSD1306_WHITE);
  oled.drawRect(2, 2, 124, 60, SSD1306_WHITE);
  centerText("! ALERTE !", 10, 2);
  centerText("INTRUS DETECTE", 34, 1);
  centerText("visage inconnu", 46, 1);
}

void drawGasAlarm() {
  oled.drawRect(0, 0, 128, 64, SSD1306_WHITE);
  oled.drawRect(2, 2, 124, 60, SSD1306_WHITE);
  centerText("! GAZ !", 10, 2);
  centerText("FUMEE / GAZ DETECTE", 32, 1);
  centerText("niveau " + String(curGas), 46, 1);
}

void drawStranger() {
  drawHeader();
  centerText("MOUVEMENT DETECTE", 16, 1);
  centerText("INCONNU", 29, 2);
  oled.drawFastHLine(10, 48, 108, SSD1306_WHITE);
  centerText("visage non reconnu", 53, 1);
}

void drawWelcome() {
  drawHeader();
  centerText("ACCES AUTORISE", 18, 1);
  // coche
  oled.drawLine(56, 34, 61, 39, SSD1306_WHITE);
  oled.drawLine(61, 39, 71, 29, SSD1306_WHITE);
  oled.drawLine(56, 35, 61, 40, SSD1306_WHITE);
  oled.drawLine(61, 40, 71, 30, SSD1306_WHITE);
  centerText(welcomeName, 46, welcomeName.length() <= 10 ? 2 : 1);
}

void oledTick() {
  if (!oledOk || millis() - lastOled < 200) return;
  lastOled = millis();
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  if (gasAlarm || buzzerOn) {
    if (gasAlarm) drawGasAlarm();
    else drawAlarm();
    oled.invertDisplay((millis() / 400) % 2);  // clignotement
  } else {
    oled.invertDisplay(false);
    // PIR lu en direct : l'ecran reagit sans attendre le cycle de mesure de 2 s
    if (millis() < strangerUntil && digitalRead(PIN_PIR)) drawStranger();
    else if (millis() < welcomeUntil) drawWelcome();
    else drawNormal();
  }
  oled.display();
}

void splash() {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.drawRect(0, 0, 128, 64, SSD1306_WHITE);
  centerText("SENTINEL-X", 14, 2);
  centerText("AetherCorp", 36, 1);
  centerText("demarrage...", 48, 1);
  oled.display();
}

void onCommand(char *topic, byte *payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;
  if (doc["buzzer"].is<bool>()) {
    buzzerOn = doc["buzzer"].as<bool>();
    resumeAlarm();  // couper le buzzer depuis le serveur ne fait pas taire une alarme gaz
  }
  // sonnerie ponctuelle : {"chime":"access"} ou {"chime":"beep"} (ignoree pendant une alarme)
  if (doc["chime"].is<const char *>() && !buzzerOn && !gasAlarm) {
    String c = doc["chime"].as<String>();
    if (c == "access") {
      play(TUNE_ACCESS, sizeof(TUNE_ACCESS) / 2, false);
      // prenom affiche sur l'OLED : police sans accents, on garde l'ASCII imprimable
      String who = doc["who"].is<const char *>() ? doc["who"].as<String>() : String("");
      welcomeName = "";
      for (size_t i = 0; i < who.length() && welcomeName.length() < 16; i++) {
        char ch = who[i];
        if (ch >= 32 && ch < 127) welcomeName += (char)toupper(ch);
      }
      welcomeUntil = millis() + 4000;
    }
    else if (c == "beep") play(TUNE_BEEP, sizeof(TUNE_BEEP) / 2, false);
  }
  // pendant une alarme gaz la LED reste rouge : l'etat publie montre au serveur le refus
  if (doc["led"].is<const char *>() && !gasAlarm) setLed(doc["led"].as<String>());
  // camera : personne non reconnue (true) ou partie (false)
  if (doc["stranger"].is<bool>()) strangerUntil = doc["stranger"].as<bool>() ? millis() + STRANGER_HOLD_MS : 0;
  statePending = true;
  Serial.printf("[cmd] buzzer=%d led=%s\n", buzzerOn,
                ledState.c_str());
}

// Etat reel des actionneurs, retenu par le broker : le dashboard affiche ce que le boitier
// fait vraiment, pas seulement ce qui a ete demande.
void publishState() {
  if (!statePending || !mqtt.connected()) return;
  JsonDocument doc;
  doc["buzzer"] = buzzerOn;
  doc["led"] = ledState;
  doc["gas_alarm"] = gasAlarm;
  doc["stranger"] = millis() < strangerUntil;
  char buf[96];
  size_t n = serializeJson(doc, buf);
  if (mqtt.publish(TOPIC_STATE, (const uint8_t *)buf, n, true)) statePending = false;
}

// Alarme gaz locale : fonctionne sans Wi-Fi ni serveur.
void checkGas(int gas) {
  if (gasWarming()) return;
  if (!gasAlarm && gas >= GAS_ALARM_ON) {
    gasAlarm = gasEdge = statePending = true;
    setLed("red");
    resumeAlarm();
    Serial.printf("[gaz] ALARME locale (%d >= %d)\n", gas, GAS_ALARM_ON);
  } else if (gasAlarm && gas < GAS_ALARM_OFF) {
    gasAlarm = false;
    statePending = true;
    setLed(buzzerOn ? "red" : "green");
    resumeAlarm();
    Serial.printf("[gaz] fin d'alarme (%d < %d)\n", gas, GAS_ALARM_OFF);
  }
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
      statePending = true;  // le serveur a pu redemarrer : on lui redonne l'etat reel
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
  // Test visuel de la LED : rouge 1 s puis vert (reste allume)
  Serial.println("\n[led] test : rouge (D8) puis vert (D0)");
  setLed("red");
  delay(1000);
  setLed("green");
  dht.begin();
  // Scan I2C : oled.begin() reussit meme sans ecran, on verifie qu'un peripherique repond
  // Diagnostic electrique : un module OLED alimente tire SDA et SCL a 3,3 V (resistances
  // de rappel integrees). Sans pull-up interne, une ligne a 0 = fil absent ou module non alimente.
  {
    int lv[2][2];
    const uint8_t lines[2] = {PIN_SDA, PIN_SCL};
    for (int i = 0; i < 2; i++) {
      pinMode(lines[i], INPUT);
      delay(5);
      lv[i][0] = digitalRead(lines[i]);
      pinMode(lines[i], INPUT_PULLUP);
      delay(5);
      lv[i][1] = digitalRead(lines[i]);
    }
    Serial.printf("\n[i2c] niveaux D2(SDA) libre=%d pullup=%d | D1(SCL) libre=%d pullup=%d", lv[0][0], lv[0][1],
                  lv[1][0], lv[1][1]);
    if (lv[0][1] == 0 || lv[1][1] == 0) Serial.print(" -> ligne court-circuitee a GND ?");
    else if (lv[0][0] == 0 || lv[1][0] == 0) Serial.print(" -> ecran non relie ou non alimente (VCC/GND)");
    else Serial.print(" -> lignes tirees a 3,3 V : ecran alimente et relie");
  }
  // Les deux sens sont essayes : SDA/SCL croises est l'erreur de cablage la plus frequente.
  uint8_t oledAddr = 0;
  const uint8_t pins[2][2] = {{PIN_SDA, PIN_SCL}, {PIN_SCL, PIN_SDA}};  // {SDA, SCL}
  for (auto &p : pins) {
    Wire.begin(p[0], p[1]);
    Serial.printf("\n[i2c] SDA=%s SCL=%s :", p[0] == D2 ? "D2" : "D1", p[1] == D1 ? "D1" : "D2");
    for (uint8_t a = 1; a < 127; a++) {
      Wire.beginTransmission(a);
      if (Wire.endTransmission() == 0) {
        Serial.printf(" 0x%02X", a);
        if (a == 0x3C || a == 0x3D) oledAddr = a;
      }
    }
    if (oledAddr) break;
  }
  Serial.println(oledAddr ? "" : " aucun ecran (verifier VCC=3V3, GND, SDA=D2, SCL=D1)");
  oledOk = oledAddr && oled.begin(SSD1306_SWITCHCAPVCC, oledAddr, true, false);  // false : garder les broches trouvees par le scan
  Serial.printf("\n[boot] OLED %s, redemarrage : %s\n", oledOk ? "OK" : "introuvable (0x3C)",
                ESP.getResetReason().c_str());
  splash();

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
  tuneTick();
  networkStep();
  tuneTick();
  if (mqtt.connected()) mqtt.loop();
  publishState();
  if (millis() > 1500) oledTick();  // laisse l'ecran de demarrage visible

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
  curGas = gas;
  curMotion = motion;
  checkGas(gas);  // avant tout test reseau : l'alarme gaz ne depend pas du serveur
  static bool lastStranger = false;
  bool stranger = millis() < strangerUntil;
  if (stranger != lastStranger) statePending = true;  // signalement camera expire
  lastStranger = stranger;

  bool edge = motion && !lastMotion;
  lastMotion = motion;
  if (!dhtOk || !mqtt.connected()) return;  // on n'envoie que des mesures valides

  JsonDocument doc;
  doc["temp"] = t;
  doc["hum"] = h;
  doc["gas"] = gas;
  doc["motion"] = motion ? 1 : 0;
  doc["motion_edge"] = edge ? 1 : 0;
  if (gasWarming()) doc["warmup"] = 1;  // le serveur n'entraine pas l'IA sur ces mesures
  doc["gas_alarm"] = gasAlarm ? 1 : 0;
  doc["gas_alarm_edge"] = gasEdge ? 1 : 0;
  char buf[200];
  size_t n = serializeJson(doc, buf);
  bool sent = mqtt.publish(TOPIC_TELEMETRY, (const uint8_t *)buf, n);
  if (sent) gasEdge = false;  // declenchement transmis
  Serial.printf("[mqtt] publish %s\n", sent ? "OK" : "ECHEC");
}
