"use strict";

// ---------- State ----------
const DEFAULT_LOCATION = { lat: 32.934, lon: -97.078, name: "Grapevine, TX" };
let app = { lat: 0, lon: 0, name: "unknown" };
let map;
let baseLayer;
let radarLayer = null;
let radarHost = "";
let radarFrames = [];
let radarFrameIndex = 0;
let radarTimer = null;

const RAINVIEWER_API = "https://api.rainviewer.com/public/weather-maps.json";
const METEOTILES = "https://tile.open-meteo.com/v1/";

// Open-Meteo WMO weather codes -> short labels
const WMO = {
  0: "Clear sky", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Light showers", 81: "Showers", 82: "Heavy showers",
  85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Storm w/ hail", 99: "Storm w/ heavy hail",
};

function wmo(code) { return WMO[code] || "Unknown"; }

// ---------- Map setup ----------
function initMap() {
  map = L.map("map", { zoomControl: true }).setView([app.lat, app.lon], 7);

  baseLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  loadRadar();
  loadWeather();
}

// ---------- Radar (RainViewer) ----------
async function loadRadar() {
  setRadarStatus("loading radar frames&hellip;");
  try {
    const res = await fetch(RAINVIEWER_API);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    radarHost = data.host;
    const past = data.radar.past || [];
    const nowcast = data.radar.nowcast || [];

    // Animate over the last few past frames, then flow into nowcast.
    radarFrames = past.slice(-8).concat(nowcast.slice(0, 4));
    if (!radarFrames.length) throw new Error("no radar frames");

    radarLayer = L.tileLayer(frameUrl(radarFrames[radarFrames.length - 1]), {
      opacity: 0.85,
      zIndex: 500,
      attribution: 'radar &copy; <a href="https://www.rainviewer.com/">RainViewer</a>',
    }).addTo(map);

    setRadarTime(data.radar.timestamps);
    setRadarStatus("live");
    startRadarAnimation();
  } catch (err) {
    setRadarStatus("radar unavailable (" + err.message + ")");
  }
}

function frameUrl(frame) {
  return radarHost + frame.path + "/256/{z}/{x}/{y}/2/1_1.png";
}

function startRadarAnimation() {
  radarFrameIndex = radarFrames.length - 1;
  if (radarTimer) window.clearInterval(radarTimer);
  radarTimer = window.setInterval(() => {
    if (!radarLayer || !radarFrames.length) return;
    radarFrameIndex = (radarFrameIndex + 1) % radarFrames.length;
    radarLayer.setUrl(frameUrl(radarFrames[radarFrameIndex]));
  }, 800);
}

function setRadarStatus(text) { document.getElementById("radar-status").innerHTML = text; }

function setRadarTime(timestamps) {
  const el = document.getElementById("radar-time");
  if (!timestamps || timestamps.length < 2) { el.textContent = ""; return; }
  const first = new Date(timestamps[0] * 1000);
  const last = new Date(timestamps[timestamps.length - 1] * 1000);
  el.textContent = "last radar sweep " + last.toLocaleTimeString() +
    " · spans " + first.toLocaleTimeString() + "–" + last.toLocaleTimeString();
}

// ---------- Weather (Open-Meteo) ----------
async function loadWeather() {
  const url =
    "https://api.open-meteo.com/v1/forecast?" +
    "latitude=" + app.lat + "&longitude=" + app.lon +
    "&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m,precipitation&" +
    "daily=weather_code,temperature_2m_max,temperature_2m_min&" +
    "timezone=auto&forecast_days=5";
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    renderCurrent(data.current);
    renderForecast(data.daily);
  } catch (err) {
    document.getElementById("cond-desc").textContent = "Weather unavailable (" + err.message + ")";
  }
}

function renderCurrent(c) {
  document.getElementById("cond-desc").textContent = wmo(c.weather_code);
  document.getElementById("cond-temp").textContent = Math.round(c.temperature_2m) + "\u00b0";
  document.getElementById("cond-feel").textContent = "feels like " + Math.round(c.apparent_temperature) + "\u00b0";
  document.getElementById("cond-humidity").textContent = c.relative_humidity_2m + "%";
  document.getElementById("cond-wind").textContent = Math.round(c.wind_speed_10m) + " km/h";
  document.getElementById("cond-precip").textContent = c.precipitation + " mm";
  document.getElementById("cond-updated").textContent = new Date().toLocaleTimeString();
  document.getElementById("cond-loc").textContent = app.name;
}

function renderForecast(daily) {
  const grid = document.getElementById("forecast-grid");
  grid.innerHTML = "";
  daily.time.forEach((date, i) => {
    const day = document.createElement("div");
    day.className = "forecast-day";

    const name = document.createElement("div");
    name.className = "day-name";
    const d = new Date(date + "T12:00:00");
    name.textContent = i === 0 ? "Today" : d.toLocaleDateString(undefined, { weekday: "short" });

    const desc = document.createElement("div");
    desc.className = "day-desc";
    desc.textContent = wmo(daily.weather_code[i]);

    const temps = document.createElement("div");
    temps.className = "day-temps";
    temps.innerHTML =
      '<span style="color:var(--accent)">' + Math.round(daily.temperature_2m_max[i]) + "\u00b0</span>" +
      ' <span class="muted">' + Math.round(daily.temperature_2m_min[i]) + "\u00b0</span>";

    day.append(name, desc, temps);
    grid.appendChild(day);
  });
}

// ---------- Location ----------
function locate() {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        app.lat = pos.coords.latitude;
        app.lon = pos.coords.longitude;
        app.name = app.lat.toFixed(2) + ", " + app.lon.toFixed(2);
        afterLocation();
      },
      () => {
        app = { ...DEFAULT_LOCATION };
        afterLocation();
      },
      { timeout: 8000 }
    );
  } else {
    app = { ...DEFAULT_LOCATION };
    afterLocation();
  }
}

function afterLocation() {
  document.getElementById("loc-name").textContent = app.name;
  document.getElementById("map").innerHTML = ""; // fresh map if relocated
  initMap();
}

// ---------- Extra layers (Open-Meteo tile layers) ----------
function tileLayerFor(kind) {
  return L.tileLayer(METETILES + kind + "/{z}/{x}/{y}.png?latitude=" + app.lat + "&longitude=" + app.lon, {
    zIndex: 400,
    opacity: 0.6,
    attribution: '&copy; <a href="https://open-meteo.com/">Open-Meteo</a>',
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const precip = tileLayerFor("precipitation");
  const temp = tileLayerFor("temperature");

  document.getElementById("layer-radar").addEventListener("change", (e) => {
    if (!radarLayer) return;
    if (e.target.checked) radarLayer.addTo(map); else radarLayer.remove();
  });
  document.getElementById("layer-precip").addEventListener("change", (e) => {
    if (e.target.checked) precip.addTo(map); else precip.remove();
  });
  document.getElementById("layer-temp").addEventListener("change", (e) => {
    if (e.target.checked) temp.addTo(map); else temp.remove();
  });

  locate();
});