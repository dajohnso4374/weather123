"use strict";

// ---------- State ----------
const DEFAULT_LOCATION = { lat: 32.934, lon: -97.078, name: "Grapevine, TX" };
let app = { lat: 0, lon: 0, name: "unknown" };
let map;
let baseLayer;
let radarHost = "";
let radarFrames = [];
let radarFrameIndex = 0;
let radarTimer = null;
let radarLayerA = null;
let radarLayerB = null;
let activeRadar = null;
let radarAnimating = false;
let lastWeather = { lat: 0, lon: 0 };
const MOVE_THRESHOLD = 0.02;
let geocodeSeq = 0;
const RADAR_REFRESH_MS = 5 * 60 * 1000;
const WEATHER_REFRESH_MS = 15 * 60 * 1000;
let radarRefreshTimer = null;
let weatherRefreshTimer = null;

// Alerts (NWS)
let alertsSeq = 0;
const NWS_ALERTS = "https://api.weather.gov/alerts/active";

// Satellite (NOAA GOES ImageServer)
const SAT_ENDPOINT =
  "https://satellitemaps.nesdis.noaa.gov/arcgis/rest/services/MERGED_GeoColor/ImageServer/exportImage";
let satEnabled = false;
let satOverlay = null;
let satBusy = false;
let satTimer = null;
let satRefreshQueued = false;

// Saved cities + search
const HOME = DEFAULT_LOCATION;
const LS_CITIES = "w123-cities";
let cities = [];
let selectedCity = null;
let citySelectPending = false;
let citySearchTimer = null;

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
  loadWeather(app.lat, app.lon, app.name);
  map.on("moveend", onMapMove);

  weatherRefreshTimer = window.setInterval(() => {
    if (lastWeather.lat || lastWeather.lon) {
      loadWeather(lastWeather.lat, lastWeather.lon, null, false);
    }
    if (hurricanesLoaded && hurricanesEnabled) loadHurricanes();
  }, WEATHER_REFRESH_MS);
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

    setupRadarLayers();

    setRadarTime();
    setRadarStatus("live");
    startRadarAnimation();
    radarRefreshTimer = window.setInterval(refreshRadar, RADAR_REFRESH_MS);
  } catch (err) {
    setRadarStatus("radar unavailable (" + err.message + ")");
  }
}

function frameUrl(frame) {
  return radarHost + frame.path + "/256/{z}/{x}/{y}/2/1_1.png";
}

function setupRadarLayers() {
  const latest = radarFrames[radarFrames.length - 1];
  radarLayerA = L.tileLayer(frameUrl(latest), {
    opacity: 0.85,
    zIndex: 500,
    attribution: 'radar &copy; <a href="https://www.rainviewer.com/">RainViewer</a>',
  }).addTo(map);
  radarLayerB = L.tileLayer(frameUrl(radarFrames[0]), {
    opacity: 0,
    zIndex: 500,
  }).addTo(map);
  activeRadar = radarLayerA;
}

function fadeRadar(layer, from, to, duration) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    function step(now) {
      const p = Math.min(1, (now - t0) / duration);
      layer.setOpacity(from + (to - from) * p);
      if (p < 1) requestAnimationFrame(step); else resolve();
    }
    requestAnimationFrame(step);
  });
}

function waitForLoad(layer, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      layer.off("load", done);
      window.clearTimeout(timer);
      resolve();
    };
    layer.once("load", done);
    const timer = window.setTimeout(done, timeout);
  });
}

function startRadarAnimation() {
  radarFrameIndex = radarFrames.length - 1;
  if (radarTimer) window.clearInterval(radarTimer);
  radarTimer = window.setInterval(() => {
    if (radarAnimating) return;
    radarAnimating = true;
    nextRadarFrame().finally(() => { radarAnimating = false; });
  }, 950);
}

async function nextRadarFrame() {
  if (!radarFrames.length || !activeRadar) return;
  radarFrameIndex = (radarFrameIndex + 1) % radarFrames.length;
  const next = activeRadar === radarLayerA ? radarLayerB : radarLayerA;

  next.setOpacity(0);
  if (!map.hasLayer(next)) next.addTo(map);
  next.bringToFront();
  next.setUrl(frameUrl(radarFrames[radarFrameIndex]));

  // Preload the frame, then crossfade so there is no tile pop/blink.
  await waitForLoad(next, 3000);
  const fadeDur = 420;
  await Promise.all([
    fadeRadar(activeRadar, 0.85, 0, fadeDur),
    fadeRadar(next, 0, 0.85, fadeDur),
  ]);
  activeRadar = next;
}

function setRadarVisible(on) {
  [radarLayerA, radarLayerB].forEach((layer) => {
    if (!layer || !map) return;
    if (on && !map.hasLayer(layer)) layer.addTo(map);
    else if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  });
}

function setRadarStatus(text) { document.getElementById("radar-status").innerHTML = text; }

function setRadarTime() {
  const el = document.getElementById("radar-time");
  if (!radarFrames.length) { el.textContent = ""; return; }
  const last = new Date(radarFrames[radarFrames.length - 1].time * 1000);
  const first = new Date(radarFrames[0].time * 1000);
  el.textContent = "last radar sweep " + last.toLocaleTimeString() +
    " · spans " + first.toLocaleTimeString() + "–" + last.toLocaleTimeString();
}

// ---------- Weather (Open-Meteo) ----------
async function loadWeather(lat, lon, label, geocode) {
  const url =
    "https://api.open-meteo.com/v1/forecast?" +
    "latitude=" + lat + "&longitude=" + lon +
    "&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m,precipitation,uv_index&" +
    "hourly=temperature_2m,precipitation_probability,weather_code&forecast_hours=24&" +
    "daily=weather_code,temperature_2m_max,temperature_2m_min&" +
    "temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&" +
    "timezone=auto&forecast_days=5";
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    renderCurrent(data.current);
    renderHourly(data.hourly);
    renderForecast(data.daily);
    loadAq(lat, lon);
    lastWeather = { lat, lon };
    loadAlerts(lat, lon);
    if (label) {
      document.getElementById("cond-loc").textContent = label;
    } else if (geocode) {
      nameFor(lat, lon);
    }
  } catch (err) {
    document.getElementById("cond-desc").textContent = "Weather unavailable (" + err.message + ")";
  }
}

// Poll RainViewer for fresh sweeps; keep old frames on failure.
async function refreshRadar() {
  try {
    const res = await fetch(RAINVIEWER_API);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const past = data.radar.past || [];
    const nowcast = data.radar.nowcast || [];
    const frames = past.slice(-8).concat(nowcast.slice(0, 4));
    if (!frames.length) throw new Error("no radar frames");

    const latestOld = radarFrames.length ? radarFrames[radarFrames.length - 1].time : -1;
    const latestNew = frames[frames.length - 1].time;
    if (latestNew === latestOld) return; // nothing new yet

    radarFrames = frames;
    radarFrameIndex = Math.min(radarFrameIndex, radarFrames.length - 1);
    setRadarTime();
  } catch (err) {
    // keep animating old frames; try again next cycle
  }
}

function onMapMove() {
  scheduleSatellite();
  if (citySelectPending) { citySelectPending = false; return; }
  if (lastWeather.lat && !centerChanged()) return;
  const c = map.getCenter();
  loadWeather(c.lat, c.lng);
  loadAlerts(c.lat, c.lng);
}

function centerChanged() {
  return Math.abs(map.getCenter().lat - lastWeather.lat) >= MOVE_THRESHOLD ||
    Math.abs(map.getCenter().lng - lastWeather.lon) >= MOVE_THRESHOLD;
}

// Best-effort reverse geocode of the map center (Nominatim).
function nameFor(lat, lon) {
  const seq = ++geocodeSeq;
  fetch(
    "https://nominatim.openstreetmap.org/reverse?lat=" + lat + "&lon=" + lon + "&format=jsonv2",
    { headers: { "User-Agent": "weather123" } }
  )
    .then((r) => r.json())
    .then((data) => {
      if (seq !== geocodeSeq) return; // stale response
      const a = data.address || {};
      const city = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || "";
      const state = a.state || a.state_code || "";
      const out = [city, state].filter(Boolean).join(", ");
      document.getElementById("cond-loc").textContent = out || lat.toFixed(2) + ", " + lon.toFixed(2);
    })
    .catch(() => {
      if (seq !== geocodeSeq) return;
      document.getElementById("cond-loc").textContent = lat.toFixed(2) + ", " + lon.toFixed(2);
    });
}

function renderCurrent(c) {
  document.getElementById("cond-desc").textContent = wmo(c.weather_code);
  document.getElementById("cond-temp").textContent = Math.round(c.temperature_2m) + "\u00b0";
  document.getElementById("cond-feel").textContent = "feels like " + Math.round(c.apparent_temperature) + "\u00b0";
  document.getElementById("cond-humidity").textContent = c.relative_humidity_2m + "%";
  document.getElementById("cond-wind").textContent = Math.round(c.wind_speed_10m) + " mph";
  document.getElementById("cond-precip").textContent = c.precipitation + " in";
  document.getElementById("cond-updated").textContent = new Date().toLocaleTimeString();

  const uv = c.uv_index == null ? -1 : +c.uv_index;
  document.getElementById("uv-val").textContent = uv < 0 ? "\u2014" : uv.toFixed(1);
  const uvLbl = document.getElementById("uv-label");
  uvLbl.textContent = uvLabel(uv);
  uvLbl.className = "air-badge " + (uv < 0 ? "" : uvClass(uv));
}

// UV index -> label + color band
function uvLabel(uv) {
  if (uv < 0) return "n/a";
  if (uv < 3) return "Low";
  if (uv < 6) return "Moderate";
  if (uv < 8) return "High";
  if (uv < 11) return "Very High";
  return "Extreme";
}

function uvClass(uv) {
  if (uv < 3) return "air-good";
  if (uv < 6) return "air-moderate";
  if (uv < 8) return "air-us";
  if (uv < 11) return "air-unhealthy";
  return "air-very";
}

// ---------- 24-hour chart ----------
function renderHourly(h) {
  const box = document.getElementById("hourly-chart");
  const err = document.getElementById("hourly-err");
  if (!h || !h.time || !h.time.length) { box.innerHTML = ""; err.textContent = ""; return; }
  const n = Math.min(24, h.time.length);
  const ts = h.time.slice(0, n).map((t) => new Date(t));
  const temps = h.temperature_2m.slice(0, n);
  const probs = (h.precipitation_probability || h.precipitation_probability_max || []).slice(0, n);
  const codes = (h.weather_code || []).slice(0, n);

  const W = 960, H = 232, padL = 34, padR = 10, padT = 14, padB = 26;
  const minT = Math.min.apply(null, temps);
  const maxT = Math.max.apply(null, temps);
  const span = Math.max(1, maxT - minT);
  const step = (W - padL - padR) / (n - 1);
  const x = (i) => padL + i * step;
  const tempTop = padT, tempBot = 104;
  const yT = (t) => tempTop + (1 - (t - minT) / span) * (tempBot - tempTop);
  const barBase = H - padB;
  const barH = (p) => (p / 100) * 96;

  let svg = "";
  svg += '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Next 24 hours temperature and rain chance">';

  // gridlines + temp axis labels
  [minT, maxT].forEach((t) => {
    const y = yT(t).toFixed(1);
    svg += '<line class="tick" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (+y + 3.5).toFixed(1) + '" text-anchor="end">' + Math.round(t) + "\u00b0</text>";
  });

  // precipitation bars
  probs.forEach((p, i) => {
    if (!(p > 0)) return;
    const bh = barH(p);
    const fill = p >= 60 ? "#54b3ff" : p >= 30 ? "rgba(84,179,255,0.55)" : "rgba(84,179,255,0.28)";
    svg += '<rect x="' + (x(i) - step * 0.3).toFixed(1) +
      '" y="' + (barBase - bh).toFixed(1) +
      '" width="' + (step * 0.6).toFixed(1) +
      '" height="' + bh.toFixed(1) + '" rx="2" fill="' + fill + '"/>' +
      '<title>' + Math.round(p) + "% chance of rain</title>";
  });

  // temperature line + dots
  const pts = temps.map((t, i) => x(i).toFixed(1) + "," + yT(t).toFixed(1));
  svg += '<polyline fill="none" stroke="#e8a33d" stroke-width="2" points="' + pts.join(" ") + '"/>';
  temps.forEach((t, i) => {
    const label = Math.round(t) + "\u00b0  " + Math.round(probs[i] || 0) + "%  " + wmo(codes[i]);
    svg += '<circle cx="' + x(i).toFixed(1) + '" cy="' + yT(t).toFixed(1) +
      '" r="3" fill="#e8a33d"><title>' + ts[i].toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) +
      ": " + label + "</title></circle>";
  });

  // weather-code dot + hour label every 3 h
  const codeColor = (c) =>
    c >= 95 ? "#b56bff" : c >= 51 ? "#54b3ff" : c >= 71 ? "#9bdcff" : c >= 45 ? "#8fa3bd" : "#ffd43b";
  for (let i = 0; i < n; i++) {
    svg += '<circle class="hcode" cx="' + x(i).toFixed(1) + '" cy="' + (H - padB + 6) +
      '" r="3" fill="' + codeColor(codes[i]) + '"/>';
    if (i % 3 === 0) {
      const lbl = ts[i].toLocaleTimeString([], { hour: "numeric" });
      svg += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + lbl + "</text>";
    }
  }

  svg += "</svg>";
  box.innerHTML = svg;
  err.textContent = "";
}

// ---------- Air quality (Open-Meteo) ----------
async function loadAq(lat, lon) {
  try {
    const res = await fetch(
      "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=" + lat + "&longitude=" + lon +
      "&current=us_aqi,pm2_5,ozone,pm10&timezone=auto"
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const c = data.current || {};
    const aqi = c.us_aqi == null ? -1 : Math.round(c.us_aqi);
    document.getElementById("aq-val").textContent = aqi < 0 ? "\u2014" : String(aqi);
    const lbl = document.getElementById("aq-label");
    lbl.textContent = aqi < 0 ? "n/a" : aqiLabel(aqi);
    lbl.className = "air-badge " + (aqi < 0 ? "" : aqiClass(aqi));
    document.getElementById("aq-pm").textContent =
      c.pm2_5 == null ? "\u2014" : c.pm2_5.toFixed(0) + " \u00b5g/m\u00b3";
    document.getElementById("aq-ozone").textContent =
      c.ozone == null ? "\u2014" : Math.round(c.ozone) + " ppb";
  } catch (err) {
    const lbl = document.getElementById("aq-label");
    lbl.textContent = "unavailable";
    lbl.className = "air-badge";
  }
}

function aqiLabel(aqi) {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

function aqiClass(aqi) {
  if (aqi <= 50) return "air-good";
  if (aqi <= 100) return "air-moderate";
  if (aqi <= 150) return "air-us";
  if (aqi <= 200) return "air-unhealthy";
  if (aqi <= 300) return "air-very";
  return "air-hazardous";
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

// ---------- Severe weather alerts (NWS) ----------
async function loadAlerts(lat, lon) {
  const seq = ++alertsSeq;
  try {
    const res = await fetch(NWS_ALERTS + "?point=" + lat.toFixed(4) + "," + lon.toFixed(4));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (seq !== alertsSeq) return;
    renderAlerts(data.features || []);
  } catch (err) {
    if (seq !== alertsSeq) return;
    renderAlerts(null, "Alerts unavailable (" + err.message + ")");
  }
}

const ALERT_SEVERITY = { Severe: "sev-severe", Moderate: "sev-moderate", Minor: "sev-minor" };

function rankSeverity(s) {
  const r = { Extreme: 0, Severe: 0, Moderate: 1, Minor: 2 }[s];
  return r === undefined ? 3 : r;
}

function renderAlerts(features, errText) {
  const card = document.getElementById("alerts");
  const body = document.getElementById("alerts-body");
  const zone = document.getElementById("alerts-zone");
  body.innerHTML = "";
  if (errText || !features || !features.length) {
    card.style.display = "none";
    zone.textContent = "";
    return;
  }
  const ranked = features
    .filter((f) => f.properties && f.properties.event)
    .sort((a, b) => rankSeverity(a.properties.severity) - rankSeverity(b.properties.severity))
    .slice(0, 6);

  card.style.display = "";
  zone.textContent = features.length + " active alert" + (features.length === 1 ? "" : "s")
    + " for this area";

  ranked.forEach((f) => {
    const p = f.properties;
    const item = document.createElement("div");
    item.className = "alert-item " + (ALERT_SEVERITY[p.severity] || "sev-unknown");

    const head = document.createElement("div");
    head.className = "alert-head";

    const badge = document.createElement("span");
    badge.className = "alert-badge";
    badge.textContent = p.severity || "Unknown";

    const ev = document.createElement("span");
    ev.className = "alert-event";
    ev.textContent = p.event;

    const area = document.createElement("span");
    area.className = "alert-area muted";
    area.textContent = p.areaDesc || "";

    head.append(badge, ev, area);

    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = p.headline || "Details";
    const desc = document.createElement("p");
    desc.textContent = [p.description, p.instruction].filter(Boolean).join(" ");
    details.append(summary, desc);

    item.append(head, details);
    body.appendChild(item);
  });
}

// ---------- Satellite layer (NOAA GOES via ImageServer export) ----------
function satUrl(w, h) {
  const b = map.getBounds();
  const NE = map.options.crs.project(b.getNorthEast());
  const SW = map.options.crs.project(b.getSouthWest());
  const bbox = [SW.x, SW.y, NE.x, NE.y].map((v) => v.toFixed(0)).join(",");
  return SAT_ENDPOINT + "?bbox=" + bbox + "&bboxSR=3857&imageSR=3857&size=" + w + "," + h + "&format=jpg&f=image";
}

function refreshSatellite() {
  if (!satEnabled || !map) return;
  if (satBusy) { satRefreshQueued = true; return; }
  satBusy = true;
  const size = map.getSize();
  const img = new Image();
  img.onload = () => {
    satBusy = false;
    if (!satEnabled) return;
    const bounds = map.getBounds();
    if (!satOverlay) {
      satOverlay = L.imageOverlay(img.src, bounds, {
        opacity: 0.85,
        zIndex: 450,
        attribution: 'satellite &copy; <a href="https://www.noaa.gov/">NOAA/STAR</a>',
      }).addTo(map);
    } else {
      satOverlay.setUrl(img.src);
      satOverlay.setBounds(bounds);
    }
    if (satRefreshQueued) { satRefreshQueued = false; scheduleSatellite(); }
  };
  img.onerror = () => { satBusy = false; };
  img.src = satUrl(size.x, size.y);
}

function scheduleSatellite() {
  if (!satEnabled) return;
  if (satTimer) window.clearTimeout(satTimer);
  satTimer = window.setTimeout(() => {
    satTimer = null;
    if (!satBusy) refreshSatellite(); else satRefreshQueued = true;
  }, 700);
}

function setSatellite(enabled) {
  satEnabled = enabled;
  if (!enabled) {
    if (satOverlay && map.hasLayer(satOverlay)) map.removeLayer(satOverlay);
    satOverlay = null;
  } else {
    refreshSatellite();
  }
}

// ---------- City search & saved tabs ----------
function loadCities() {
  try {
    const raw = localStorage.getItem(LS_CITIES);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function saveCities() {
  try { localStorage.setItem(LS_CITIES, JSON.stringify(cities)); } catch { /* ignore */ }
}

function renderCityTabs() {
  const tabs = document.getElementById("city-tabs");
  tabs.innerHTML = "";

  const mkTab = (city, active) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "city-tab" + (active ? " active" : "");
    btn.textContent = city.name;
    btn.title = city.name;
    if (city !== HOME) {
      const x = document.createElement("span");
      x.className = "city-remove";
      x.textContent = "x";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        removeCity(city);
      });
      btn.appendChild(x);
    }
    btn.addEventListener("click", () => selectCity(city));
    return btn;
  };

  tabs.appendChild(mkTab(HOME, !selectedCity));
  cities.forEach((c) => tabs.appendChild(mkTab(c, selectedCity === c)));
}

function selectCity(city) {
  selectedCity = city;
  citySelectPending = true;
  map.setView([city.lat, city.lon], city === HOME ? 7 : 8);
  document.getElementById("loc-name").textContent = city.name;
  loadWeather(city.lat, city.lon, city.name);
  loadAlerts(city.lat, city.lon);
  renderCityTabs();
}

function removeCity(city) {
  cities = cities.filter((c) => c !== city);
  saveCities();
  if (selectedCity === city) selectedCity = null;
  renderCityTabs();
}

function addSavedCity(city) {
  if (!cities.some((c) => Math.abs(c.lat - city.lat) < 0.01 && Math.abs(c.lon - city.lon) < 0.01)) {
    cities.push(city);
    saveCities();
  }
  selectCity(city);
}

function setupCitySearch() {
  const input = document.getElementById("city-search");
  const box = document.getElementById("city-results");

  input.addEventListener("input", () => {
    if (citySearchTimer) window.clearTimeout(citySearchTimer);
    const q = input.value.trim();
    if (q.length < 2) { box.classList.remove("open"); box.innerHTML = ""; return; }
    citySearchTimer = window.setTimeout(() => geocodeCity(q), 350);
  });

  input.addEventListener("blur", () => {
    window.setTimeout(() => box.classList.remove("open"), 150);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#city-search") && !e.target.closest("#city-results")) box.classList.remove("open");
  });
}

async function geocodeCity(q) {
  const box = document.getElementById("city-results");
  try {
    const res = await fetch(
      "https://geocoding-api.open-meteo.com/v1/search?name=" + encodeURIComponent(q) +
      "&count=6&language=en&format=json"
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const results = data.results || [];
    box.innerHTML = "";
    results.forEach((r) => {
      const item = document.createElement("div");
      item.className = "city-result-item";
      item.textContent = [r.name, r.admin1, r.country_code].filter(Boolean).join(", ");
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        addSavedCity({ lat: r.latitude, lon: r.longitude, name: r.name });
        document.getElementById("city-search").value = "";
        box.classList.remove("open");
        box.innerHTML = "";
      });
      box.appendChild(item);
    });
    box.classList.toggle("open", results.length > 0);
  } catch {
    box.classList.remove("open");
  }
}

// ---------- World clocks ----------
const WORLD_CLOCKS = [
  { city: "Moscow", tz: "Europe/Moscow" },
  { city: "London", tz: "Europe/London" },
  { city: "Tehran", tz: "Asia/Tehran" },
  { city: "Tel Aviv", tz: "Asia/Jerusalem" },
  { city: "Chicago", tz: "America/Chicago" },
  { city: "Tokyo", tz: "Asia/Tokyo" },
  { city: "Beijing", tz: "Asia/Shanghai" },
];
const clockFormats = new Map();

function buildClocks() {
  const wrap = document.getElementById("clocks");
  if (!wrap) return;
  WORLD_CLOCKS.forEach(({ city, tz }) => {
    const div = document.createElement("div");
    div.className = "clock";
    div.dataset.tz = tz;

    const cityEl = document.createElement("span");
    cityEl.className = "clock-city";
    cityEl.textContent = city;

    const timeEl = document.createElement("time");
    timeEl.className = "clock-time";
    timeEl.textContent = "--:--:--";

    div.append(cityEl, timeEl);
    wrap.appendChild(div);
  });
  tickClocks();
  window.setInterval(tickClocks, 1000);
}

function tickClocks() {
  const now = new Date();
  document.querySelectorAll(".clock").forEach((el) => {
    const tz = el.dataset.tz;
    let fmt = clockFormats.get(tz);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat("en-US", {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false, timeZone: tz,
      });
      clockFormats.set(tz, fmt);
    }
    el.querySelector(".clock-time").textContent = fmt.format(now);
  });
}

// ---------- Active tropical cyclones (NHC via Esri) ----------
const HURRICANE_FS =
  "https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/Active_Hurricanes_v1/FeatureServer";
const STORM_COLORS = ["#ffd43b", "#ff9f1c", "#ff6b4d", "#c952ff", "#4dd2ff", "#39d98a"];
let hurricaneLayers = null;
let hurricanesEnabled = false;
let hurricanesLoaded = false;
let hurricaneBusy = false;
let hurricaneStorms = [];
let hurricaneSeq = 0;

async function loadHurricanes() {
  if (hurricaneBusy) return;
  hurricaneBusy = true;
  const status = document.getElementById("storms-status");
  try {
    const results = await Promise.all(
      [0, 2, 3, 4, 5].map((lid) =>
        fetch(HURRICANE_FS + "/" + lid + "/query?where=1%3D1&f=geoJSON&returnGeometry=true&outSR=4326&outFields=*")
          .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
          .catch(() => null)
      )
    );
    const [posFC, fcTrackFC, obsTrackFC, coneFC, wwFC] = results;
    hurricaneStorms = summarizeStorms(posFC);
    drawHurricanes(posFC, fcTrackFC, obsTrackFC, coneFC, wwFC);
    renderStormChips(hurricaneStorms);
    hurricanesLoaded = true;

    const card = document.getElementById("storms");
    if (hurricaneStorms.length) {
      card.style.display = "";
      status.textContent = "NHC feed \u00b7 " + new Date().toLocaleTimeString();
    } else {
      card.style.display = "none";
    }
  } catch (err) {
    const card = document.getElementById("storms");
    if (card && card.style.display !== "none") {
      status.textContent = "storm data unavailable (" + err.message + ")";
    }
  } finally {
    hurricaneBusy = false;
  }
}

function summarizeStorms(posFC) {
  const map = new Map();
  (posFC && posFC.features || []).forEach((f) => {
    const a = f.properties || {};
    if (!a.STORMNAME) return;
    let s = map.get(a.STORMNAME);
    if (!s) { s = { name: a.STORMNAME, points: [] }; map.set(a.STORMNAME, s); }
    if (a.LAT != null && a.LON != null) {
      s.points.push({ lat: a.LAT, lon: a.LON, tau: a.TAU || 0, wind: a.MAXWIND, mslp: a.MSLP, dir: a.TCDIR, spd: a.TCSPD, ssnum: a.SSNUM, src: a.STORMSRC || "", dvel: a.DATELBL || "" });
    }
  });
  const out = [];
  map.forEach((s) => {
    const cur = s.points.find((p) => p.tau === 0) || s.points[0];
    if (!cur) return;
    out.push({ name: s.name, windKt: cur.wind, mslp: cur.mslp, dirDeg: cur.dir, spdKt: cur.spd, ssnum: cur.ssnum, src: cur.src, lat: cur.lat, lon: cur.lon });
  });
  return out.sort((a, b) => (b.windKt || 0) - (a.windKt || 0));
}

function stormColor(name) {
  const i = hurricaneStorms.findIndex((s) => s.name === name);
  return STORM_COLORS[i < 0 ? 0 : i % STORM_COLORS.length];
}

function catInfo(s) {
  if (s.ssnum >= 1) return { cls: "cat-3", label: "Category " + s.ssnum };
  if (s.windKt >= 64) return { cls: "cat-3", label: "Hurricane" };
  if (s.windKt >= 50) return { cls: "cat-1", label: "Severe Storm" };
  if (s.windKt >= 34) return { cls: "cat-ts", label: "Tropical Storm" };
  return { cls: "cat-other", label: s.src || "Disturbance" };
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
function compass(deg) {
  if (deg == null || isNaN(deg)) return "";
  return COMPASS[Math.round(((deg + 450) % 360) / 22.5) % 16];
}

function drawHurricanes(posFC, fcTrackFC, obsTrackFC, coneFC, wwFC) {
  if (!hurricaneLayers) hurricaneLayers = L.featureGroup();
  const onMap = map && map.hasLayer(hurricaneLayers);
  if (onMap) map.removeLayer(hurricaneLayers);
  hurricaneLayers.clearLayers();

  if (fcTrackFC && fcTrackFC.features && fcTrackFC.features.length) {
    hurricaneLayers.addLayer(L.geoJSON(fcTrackFC, {
      style: (f) => ({ color: stormColor(f.properties.STORMNAME), weight: 2, dashArray: "5 5", opacity: 0.9 }),
    }));
  }
  if (obsTrackFC && obsTrackFC.features && obsTrackFC.features.length) {
    hurricaneLayers.addLayer(L.geoJSON(obsTrackFC, {
      style: (f) => ({ color: stormColor(f.properties.STORMNAME), weight: 2, opacity: 0.75 }),
    }));
  }
  if (coneFC && coneFC.features && coneFC.features.length) {
    hurricaneLayers.addLayer(L.geoJSON(coneFC, {
      style: (f) => {
        const c = stormColor(f.properties.STORMNAME);
        return { color: c, fillColor: c, fillOpacity: 0.12, weight: 1, opacity: 0.8 };
      },
    }));
  }
  if (wwFC && wwFC.features && wwFC.features.length) {
    const WW = {
      "Hurricane Warning": "#ff4d5e", "Hurricane Watch": "#ff9f1c",
      "Tropical Storm Warning": "#ff6b4d", "Tropical Storm Watch": "#ffd43b",
      "Tropical Depression Warning": "#ffb3c1", "Extratropical Warning": "#4dd2ff",
    };
    hurricaneLayers.addLayer(L.geoJSON(wwFC, {
      style: (f) => {
        const col = WW[f.properties.PLBL] || stormColor(f.properties.STORMNAME);
        return { color: col, fillColor: col, fillOpacity: 0.22, weight: 1.5 };
      },
    }));
  }
  if (posFC && posFC.features && posFC.features.length) {
    hurricaneLayers.addLayer(L.geoJSON(posFC, {
      pointToLayer: (f, latlng) => {
        const a = f.properties;
        const tau = a.TAU || 0;
        if (tau === 0) {
          const s = hurricaneStorms.find((st) => st.name === a.STORMNAME);
          return L.circleMarker(latlng, {
            radius: 6, color: "#ff4d5e", fillColor: "#ff4d5e", fillOpacity: 0.9, weight: 1.5,
          }).bindPopup(
            "<b>" + a.STORMNAME + "</b> " + (s ? catInfo(s).label : "") +
            "<br>center " + a.LAT + ", " + a.LON +
            (a.MAXWIND != null ? "<br>winds " + a.MAXWIND + " kt" + (a.GUST != null ? " (gust " + a.GUST + ")" : "") : "") +
            (a.MSLP != null ? "<br>pressure " + a.MSLP + " mb" : "") +
            (a.TCDIR != null ? "<br>moving " + compass(a.TCDIR) + " at " + a.TCSPD + " kt" : "") +
            (a.DATELBL ? "<br>" + a.DATELBL : "")
          );
        }
        return L.circleMarker(latlng, {
          radius: 3, color: stormColor(a.STORMNAME), fillColor: null,
          fillOpacity: 0.2, weight: 1.5, opacity: 0.8,
        });
      },
    }));
  }

  if (onMap || hurricanesEnabled) map.addLayer(hurricaneLayers);
}

function renderStormChips(storms) {
  const wrap = document.getElementById("storms-list");
  wrap.innerHTML = "";
  storms.forEach((s) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "h-chip";

    const name = document.createElement("span");
    name.className = "h-name";
    name.textContent = s.name;

    const cat = document.createElement("span");
    cat.className = "h-cat " + catInfo(s).cls;
    cat.textContent = catInfo(s).label;

    const meta = document.createElement("span");
    meta.className = "h-meta";
    const parts = [];
    if (s.windKt != null) parts.push("wind " + s.windKt + " kt");
    if (s.mslp != null) parts.push(s.mslp + " mb");
    if (s.dirDeg != null) parts.push("moving " + compass(s.dirDeg) + " at " + s.spdKt + " kt");
    meta.textContent = parts.join(" \u00b7 ");

    btn.append(name, cat, meta);
    btn.addEventListener("click", () => {
      map.setView([s.lat, s.lon], 4);
    });
    wrap.appendChild(btn);
  });
}
function tileLayerFor(kind) {
  return L.tileLayer(METEOTILES + kind + "/{z}/{x}/{y}.png?latitude=" + app.lat + "&longitude=" + app.lon, {
    zIndex: 400,
    opacity: 0.6,
    attribution: '&copy; <a href="https://open-meteo.com/">Open-Meteo</a>',
  });
}

document.addEventListener("DOMContentLoaded", () => {
  buildClocks();
  cities = loadCities();
  renderCityTabs();
  setupCitySearch();

  const precip = tileLayerFor("precipitation");
  const temp = tileLayerFor("temperature");

  document.getElementById("layer-radar").addEventListener("change", (e) => {
    setRadarVisible(e.target.checked);
  });
  document.getElementById("layer-sat").addEventListener("change", (e) => {
    setSatellite(e.target.checked);
  });
  document.getElementById("layer-hurr").addEventListener("change", (e) => {
    hurricanesEnabled = e.target.checked;
    if (hurricanesEnabled) {
      if (hurricanesLoaded) {
        if (map && !map.hasLayer(hurricaneLayers)) map.addLayer(hurricaneLayers);
      } else {
        loadHurricanes();
      }
    } else if (map && map.hasLayer(hurricaneLayers)) {
      map.removeLayer(hurricaneLayers);
    }
  });
  document.getElementById("layer-precip").addEventListener("change", (e) => {
    if (e.target.checked) precip.addTo(map); else precip.remove();
  });
  document.getElementById("layer-temp").addEventListener("change", (e) => {
    if (e.target.checked) temp.addTo(map); else temp.remove();
  });

  loadHurricanes();
  locate();
});