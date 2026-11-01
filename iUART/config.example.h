// iUART settings. Copy this file to config.h (ignored by git) and fill in your networks.
#pragma once
#include <Arduino.h>

// Wi-Fi networks, tried in order. Leave the IP at 0.0.0.0 to get an address by DHCP,
// or set a fixed one (with gateway and subnet) so the console is always at the same address.
struct WifiNetwork {
  const char* ssid;
  const char* password;
  IPAddress ip;
  IPAddress gateway;
  IPAddress subnet;
};

static const WifiNetwork WIFI_NETWORKS[] = {
  {"your-network", "your-password", IPAddress(0, 0, 0, 0), IPAddress(0, 0, 0, 0), IPAddress(0, 0, 0, 0)},
  // {"second-network", "password", IPAddress(192, 168, 1, 100), IPAddress(192, 168, 1, 1), IPAddress(255, 255, 255, 0)},
};

// If no network connects, iUART opens its own access point (console at http://192.168.4.1)
#define AP_SSID "iUART"
#define AP_PASSWORD "iuart-console"   // at least 8 characters

// Also reachable as http://iuart.local on networks with mDNS
#define HOSTNAME "iuart"

#define DEFAULT_BAUD 115200   // 9600 for most Arduino sketches, 115200 for Linux boards

// Lines a device repeats endlessly (e.g. a Linux board without a network cable) are counted
// in the toolbar instead of being printed. Add your own or leave the list empty ("").
static const char* const MUTED_LINES[] = {
  "udhcpc: broadcasting discover",
};
