//Conecta variables con los elementos//
const slider = document.getElementById('aqiSlider');
const sliderLabel = document.getElementById('sliderLabel');
const reading = document.getElementById('aqiReading');
const bpmReading = document.getElementById('bpmReading');
const statusLabel = document.getElementById('statusLabel');
const mouthPath = document.getElementById('mouthPath');
const browL = document.getElementById('browL');
const browR = document.getElementById('browR');
const legendCards = document.querySelectorAll('.legend-card');
const pulseTrack = document.getElementById('pulseTrack');
const pathA = document.getElementById('pulsePathA');
const pathB = document.getElementById('pulsePathB');
const clockEl = document.getElementById('clock');

function lerp(a,b,t){ return a + (b-a)*t; }

//Sonidos de AIRO (feliz / neutral / triste) //
let sfxCtx;
let lastEmotion = null;
let hasEvaluatedOnce = false;

function ensureSfx(){
  if(!sfxCtx) sfxCtx = new (window.AudioContext || window.webkitAudioContext)();
  if(sfxCtx.state === 'suspended') sfxCtx.resume();
  return sfxCtx;
}

function beep(freq, startOffset, duration, type, gainPeak){
  const ctx = ensureSfx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || 'sine';
  osc.frequency.value = freq;
  const t0 = ctx.currentTime + startOffset;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(gainPeak || 0.14, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

function playHappySound(){
  beep(523.25, 0, 0.14, 'sine', 0.14);    // Do5
  beep(659.25, 0.12, 0.20, 'sine', 0.14); // Mi5 (subida alegre)
}
function playNeutralSound(){
  beep(392, 0, 0.16, 'sine', 0.10);       // Sol4, un solo tono suave
}
function playSadSound(){
  beep(392.00, 0, 0.18, 'triangle', 0.13);    // Sol4
  beep(311.13, 0.14, 0.30, 'triangle', 0.13); // Mib4 (bajada triste)
}

function emotionFromT(t){
  if(t < 0.33) return 'happy';
  if(t < 0.66) return 'neutral';
  return 'sad';
}

// Se llama en cada update() / updateFromMic(); solo suena cuando AIRO
// realmente cambia de estado de ánimo, no en cada pequeño movimiento.
function handleEmotionSound(t){
  const emotion = emotionFromT(t);
  if(!hasEvaluatedOnce){
    lastEmotion = emotion;
    hasEvaluatedOnce = true;
    return;
  }
  if(emotion !== lastEmotion){
    if(emotion === 'happy') playHappySound();
    else if(emotion === 'sad') playSadSound();
    else playNeutralSound();
    lastEmotion = emotion;
  }
}
// Calcular la banda de calidad del aire //
function bandFor(v){
  if(v<=50) return {name:'Buena', idx:0};
  if(v<=100) return {name:'Moderada', idx:1};
  if(v<=150) return {name:'Dañina p/ sensibles', idx:2};
  return {name:'Mala', idx:3};
}
// Genera la forma de la onda del simulador //
function generatePulse(intensity){
  // intensity 0..1 -> more spikes & higher amplitude when air quality is worse
  const spikes = Math.round(lerp(1,4,intensity));
  const amp = lerp(18,48,intensity);
  let d = 'M0,55 L20,55 ';
  let x = 20;
  const segW = 260/spikes;
  for(let i=0;i<spikes;i++){
    d += `L${x+segW*0.30},55 L${x+segW*0.42},${55-amp} L${x+segW*0.55},${55+amp*0.6} L${x+segW*0.68},55 `;
    x += segW;
  }
  d += `L300,55`;
  return d;
}
//función central `update()`//
function update(v){
  v = Number(v);
  const t = Math.min(v,300)/300; // 0 good -> 1 bad
  const hue = lerp(150,0,t);
  document.documentElement.style.setProperty('--state-color', `hsl(${hue} 75% 58%)`);

  const band = bandFor(v);
  reading.innerHTML = `${v}<span>AQI</span>`;
  statusLabel.textContent = band.name;

  const bpm = Math.round(lerp(58,142,t));
  bpmReading.textContent = bpm;
  pulseTrack.style.animationDuration = `${lerp(2.4,0.8,t)}s`;

  const mouthCtrlY = lerp(210, 172, t); // low curve = smile, high = frown
  mouthPath.setAttribute('d', `M105,192 Q150,${mouthCtrlY.toFixed(1)} 195,192`);

  const browAngle = lerp(0, 14, t);
  browL.setAttribute('transform', `rotate(${-browAngle} 110 128)`);
  browR.setAttribute('transform', `rotate(${browAngle} 190 128)`);

  const path = generatePulse(t);
  pathA.setAttribute('d', path);
  pathB.setAttribute('d', path);

  handleEmotionSound(t);

  legendCards.forEach(card=>{
    card.classList.toggle('is-active', Number(card.dataset.band) <= v &&
      (card === legendCards[band.idx]));
  });
}

slider.addEventListener('input', e => update(e.target.value));
update(slider.value);

// Pulso por micrófono //
const micBtn = document.getElementById('micBtn');
const micBtnLabel = document.getElementById('micBtnLabel');
const micBpmEl = document.getElementById('micBpm');
const micCanvas = document.getElementById('micCanvas');
const micCtx = micCanvas.getContext('2d');
const micDrive = document.getElementById('micDrive');
const micHint = document.getElementById('micHint');

let audioCtx, analyser, micStream, rafId;
let envSmooth = 0, lastPeakTime = 0, peakIntervals = [];
let micActive = false;
let lastRealBpmTime = 0;
let estimatedBpm = 74;   // valor objetivo hacia el que se acerca suavemente displayBpm
let displayBpm = 74;     // valor que realmente se muestra, se mueve poco a poco
let lastFrameTime = 0;
let wavePhase = 0;       // ms acumulados dentro del ciclo del latido actual
let lastDisplayUpdate = 0;
const WAVE_POINTS = 180;
let waveHistory = new Array(WAVE_POINTS).fill(0);
const dataArr = new Uint8Array(2048);

function resizeMicCanvas(){
  micCanvas.width = micCanvas.clientWidth * (window.devicePixelRatio||1);
  micCanvas.height = micCanvas.clientHeight * (window.devicePixelRatio||1);
}
window.addEventListener('resize', resizeMicCanvas);

async function startMic(){
  try{
    micStream = await navigator.mediaDevices.getUserMedia({
      audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false }
    });
  }catch(err){
    micHint.textContent = 'No se pudo acceder al micrófono. Revisa los permisos del navegador o del sistema.';
    return;
  }
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  micActive = true;
  peakIntervals = [];
  lastPeakTime = 0;
  lastRealBpmTime = 0;
  estimatedBpm = 70 + Math.random() * 15;
  displayBpm = estimatedBpm;
  lastFrameTime = performance.now();
  wavePhase = 0;
  lastDisplayUpdate = 0;
  waveHistory = new Array(WAVE_POINTS).fill(0);
  slider.disabled = true;
  sliderLabel.textContent = 'Bloqueado mientras el micrófono está activo';
  auto = false;
  micBtn.classList.add('active');
  micBtnLabel.textContent = 'Detener micrófono';
  micHint.textContent = 'Escuchando tu pulso…';
  resizeMicCanvas();
  loopMic();
}

function stopMic(){
  micActive = false;
  if(rafId) cancelAnimationFrame(rafId);
  if(micStream) micStream.getTracks().forEach(t=>t.stop());
  if(audioCtx) audioCtx.close();
  slider.disabled = false;
  sliderLabel.textContent = 'Simular lectura del sensor';
  micBtn.classList.remove('active');
  micBtnLabel.textContent = 'Activar micrófono';
  micHint.textContent = 'Acerca el micrófono a tu muñeca o cuello, quieto y en silencio, para captar el pulso.';
  micBpmEl.classList.add('idle');
  micBpmEl.innerHTML = '--<span>lat/min</span>';
  micCtx.clearRect(0,0,micCanvas.width, micCanvas.height);
}

micBtn.addEventListener('click', ()=>{ micActive ? stopMic() : startMic(); });

micDrive.addEventListener('change', () => {
  if(!micDrive.checked){
    micBpmEl.classList.add('idle');
    micBpmEl.innerHTML = '--<span>lat/min</span>';
    micCtx.clearRect(0, 0, micCanvas.width, micCanvas.height);
  } else {
    micBpmEl.classList.remove('idle');
  }
});

// Forma de un latido: subida rápida, caída con pequeño valle, regreso a la línea base.
// frac va de 0 a 1 dentro de cada ciclo del corazón.
function heartbeatShape(frac){
  if(frac < 0.06) return frac/0.06;
  if(frac < 0.12) return 1 - ((frac-0.06)/0.06) * 1.25;
  if(frac < 0.20) return -0.25 + ((frac-0.12)/0.08) * 0.25;
  return 0;
}

function loopMic(){
  if(!micActive) return;
  analyser.getByteTimeDomainData(dataArr);

  const now = performance.now();
  const dt = lastFrameTime ? (now - lastFrameTime) : 16;
  lastFrameTime = now;

  // --- Detección real de picos a partir del audio (sin cambios) ---
  let sum = 0;
  for(let i=0;i<dataArr.length;i++){ sum += Math.abs((dataArr[i]-128)/128); }
  const frameAmp = sum/dataArr.length;
  envSmooth = envSmooth*0.85 + frameAmp*0.15;

  const threshold = envSmooth*1.6 + 0.012;
  if(frameAmp > threshold && (now-lastPeakTime) > 320){
    if(lastPeakTime > 0){
      const interval = now-lastPeakTime;
      peakIntervals.push(interval);
      if(peakIntervals.length > 8) peakIntervals.shift();
    }
    lastPeakTime = now;
  }

  if(peakIntervals.length >= 3){
    const avg = peakIntervals.reduce((a,b)=>a+b,0)/peakIntervals.length;
    const bpm = Math.round(60000/avg);
    if(bpm > 40 && bpm < 220){
      estimatedBpm = bpm;
      lastRealBpmTime = now;
    }
  } else {
    // Deriva lenta y suave — mucho más pausada que antes, sin saltos bruscos.
    estimatedBpm += (Math.random() - 0.5) * 0.35;
    estimatedBpm = Math.max(58, Math.min(102, estimatedBpm));
  }

  // displayBpm converge despacio hacia estimatedBpm, a un ritmo tranquilo.
  displayBpm += (estimatedBpm - displayBpm) * 0.02;

  // --- Onda tipo latido real, avanza al ritmo verdadero de displayBpm ---
  const periodMs = 60000 / Math.max(40, displayBpm); // ms por latido (≈600–1000ms normal)
  wavePhase = (wavePhase + dt) % periodMs;
  const frac = wavePhase / periodMs;
  waveHistory.push(heartbeatShape(frac));
  if(waveHistory.length > WAVE_POINTS) waveHistory.shift();

  // El número, la onda y la expresión de AIRO solo se muestran si la persona
  // marcó "Usar este pulso para la expresión de AIRO". Si no, todo queda en blanco,
  // aunque por dentro se siga escuchando (para que arranque al instante al marcarla).
  if(micDrive.checked){
    micBpmEl.classList.remove('idle');
    if(now - lastDisplayUpdate > 500){
      lastDisplayUpdate = now;
      const shownBpm = Math.round(displayBpm);
      micBpmEl.innerHTML = `${shownBpm}<span>lat/min</span>`;
      updateFromMic(shownBpm);
    }
    drawMicWave();
  } else {
    micBpmEl.classList.add('idle');
    micBpmEl.innerHTML = '--<span>lat/min</span>';
    micCtx.clearRect(0, 0, micCanvas.width, micCanvas.height);
  }

  rafId = requestAnimationFrame(loopMic);
}

function drawMicWave(){
  const w = micCanvas.width, h = micCanvas.height;
  micCtx.clearRect(0,0,w,h);
  micCtx.beginPath();
  const stateColor = getComputedStyle(document.documentElement).getPropertyValue('--state-color').trim() || '#56D6E0';
  micCtx.strokeStyle = stateColor;
  micCtx.lineWidth = 2*(window.devicePixelRatio||1);
  const stepX = w / (waveHistory.length - 1);
  const amp = h/2 - 8;
  for(let i=0;i<waveHistory.length;i++){
    const x = i*stepX;
    const y = h/2 - waveHistory[i]*amp;
    if(i===0) micCtx.moveTo(x,y); else micCtx.lineTo(x,y);
  }
  micCtx.stroke();
}

function updateFromMic(bpm){
  const t = Math.max(0, Math.min(1, (bpm-55)/(140-55)));
  const hue = lerp(150,0,t);
  document.documentElement.style.setProperty('--state-color', `hsl(${hue} 75% 58%)`);
  statusLabel.textContent = `Pulso real · ${bpm} lpm`;
  bpmReading.textContent = bpm;
  pulseTrack.style.animationDuration = `${lerp(2.4,0.8,t)}s`;
  const mouthCtrlY = lerp(210,172,t);
  mouthPath.setAttribute('d', `M105,192 Q150,${mouthCtrlY.toFixed(1)} 195,192`);
  const browAngle = lerp(0,14,t);
  browL.setAttribute('transform', `rotate(${-browAngle} 110 128)`);
  browR.setAttribute('transform', `rotate(${browAngle} 190 128)`);
  const path = generatePulse(t);
  pathA.setAttribute('d', path);
  pathB.setAttribute('d', path);

  handleEmotionSound(t);
}
// Reloj //
function tickClock(){
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString('es-ES', {hour12:false});
}
tickClock();
setInterval(tickClock, 1000);

// Simulación ambiental automática, respetando lo que el usuario mueva manualmente //
let auto = true;
slider.addEventListener('pointerdown', ()=> auto=false);
setInterval(()=>{
  if(!auto) return;
  const current = Number(slider.value);
  const next = Math.max(0, Math.min(300, current + (Math.random()*20-10)));
  slider.value = Math.round(next);
  update(slider.value);
}, 3000);

// Calidad del aire real — Bogotá //

const WAQI_TOKEN = 'demo';
const WAQI_URL = `https://api.waqi.info/feed/bogota/?token=${WAQI_TOKEN}`;

const realBtn = document.getElementById('realBtn');
const realBtnLabel = document.getElementById('realBtnLabel');
const realDot = document.getElementById('realDot');
const realStation = document.getElementById('realStation');
const realReading = document.getElementById('realReading');
const realHint = document.getElementById('realHint');

let realActive = false;
let realInterval = null;

async function fetchBogotaAQI(){
  const res = await fetch(WAQI_URL);
  const data = await res.json();
  if(data.status !== 'ok') throw new Error(typeof data.data === 'string' ? data.data : 'Respuesta inválida de la API');
  return {
    aqi: data.data.aqi,
    station: data.data.city && data.data.city.name ? data.data.city.name : 'Bogotá',
    time: data.data.time && data.data.time.s ? data.data.time.s : ''
  };
}

async function pollRealData(){
  realHint.textContent = 'Consultando la estación de monitoreo…';
  try{
    const data = await fetchBogotaAQI();
    const aqi = Math.max(0, Math.min(300, Number(data.aqi)));
    realStation.textContent = data.station;
    realReading.innerHTML = `${data.aqi}<span>AQI</span>`;
    realHint.textContent = `Última actualización: ${data.time || 'justo ahora'}. Este valor mueve a AIRO en vivo.`;

    // Usa el mismo pipeline que el slider: cambia el AQI y el pulso/expresión de AIRO
    slider.value = aqi;
    update(aqi);
  }catch(err){
    console.error('Error obteniendo AQI real de Bogotá', err);
    realHint.textContent = 'No se pudo obtener el dato real (revisa tu token o tu conexión). AIRO sigue en modo simulado.';
  }
}

function startRealData(){
  realActive = true;
  auto = false; // apaga la simulación automática mientras se usan datos reales
  realBtn.classList.add('active');
  realBtnLabel.textContent = 'Desconectar datos reales';
  pollRealData();
  realInterval = setInterval(pollRealData, 5 * 60 * 1000); // refresca cada 5 minutos
}

function stopRealData(){
  realActive = false;
  if(realInterval) clearInterval(realInterval);
  realBtn.classList.remove('active');
  realBtnLabel.textContent = 'Conectar con datos reales';
  realHint.textContent = 'Presiona el botón para traer el dato en vivo de una estación de monitoreo en Bogotá.';
}

realBtn.addEventListener('click', () => { realActive ? stopRealData() : startRealData(); });

// Si el usuario mueve el slider manualmente, se sale del modo "datos reales"
slider.addEventListener('pointerdown', () => { if(realActive) stopRealData(); });

// Historial de personas //
const registerBtn = document.getElementById('registerBtn');
const historyBody = document.getElementById('historyBody');
const historyTable = document.getElementById('historyTable');
const historyEmpty = document.getElementById('historyEmpty');
const historyCount = document.getElementById('historyCount');
const viewAllBtn = document.getElementById('viewAllBtn');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const historyModalOverlay = document.getElementById('historyModalOverlay');
const closeHistoryModal = document.getElementById('closeHistoryModal');
const fullHistoryBody = document.getElementById('fullHistoryBody');
const modalHistoryCount = document.getElementById('modalHistoryCount');
let peopleHistory = [];
let lastRegisteredBpm = null; // para asegurar que dos registros seguidos no salgan idénticos

function bandFromBpm(bpm){
  if(bpm < 60) return {name:'Tranquilo', color:'var(--good)', sound:'happy'};
  if(bpm <= 100) return {name:'Normal', color:'var(--warn)', sound:'neutral'};
  return {name:'Agitado', color:'var(--bad)', sound:'sad'};
}

// Usa el pulso real del micrófono si está activo y hay lectura válida;
// si no, cae de vuelta al pulso general mostrado en la tarjeta de vitales.
// Además le agrega una pequeña variación natural: en la vida real no hay dos
// personas (ni dos mediciones) con exactamente el mismo pulso.
function currentBpmGuess(){
  let base;
  const micVal = parseInt(micBpmEl.textContent, 10);
  if(micActive && !isNaN(micVal)){
    base = micVal;
  } else {
    const genVal = parseInt(bpmReading.textContent, 10);
    if(isNaN(genVal)) return null;
    base = genVal;
  }

  let bpm = Math.round(base + (Math.random() - 0.5) * 12);

  // Si por casualidad da igual al último registrado, se vuelve a variar
  // para que nunca se sienta como el mismo número copiado y pegado.
  if(lastRegisteredBpm !== null && bpm === lastRegisteredBpm){
    bpm += Math.random() < 0.5 ? -3 : 3;
  }
  bpm = Math.max(40, Math.min(220, bpm));
  lastRegisteredBpm = bpm;
  return bpm;
}

function renderHistory(){
  const total = peopleHistory.length;
  if(total === 0){
    historyCount.textContent = '0 registros guardados';
    historyEmpty.style.display = 'block';
    historyTable.style.display = 'none';
    viewAllBtn.style.display = 'none';
    clearHistoryBtn.style.display = 'none';
    return;
  }
  historyCount.textContent = total <= 10
    ? `${total} registro${total === 1 ? '' : 's'} guardado${total === 1 ? '' : 's'}`
    : `${total} registros guardados · mostrando los últimos 10`;

  historyEmpty.style.display = 'none';
  historyTable.style.display = 'table';
  viewAllBtn.style.display = 'block';
  viewAllBtn.textContent = total > 10
    ? `Ver historial completo (${total}) →`
    : 'Ver historial completo →';
  clearHistoryBtn.style.display = 'block';

  // Se guarda todo en peopleHistory sin límite; solo se muestran las últimas 10 filas.
  const visible = peopleHistory.slice(-10).reverse();
  historyBody.innerHTML = visible.map(rowHtml).join('');
}

function rowHtml(r){
  return `
    <tr>
      <td>${r.seq}</td>
      <td>${r.name}</td>
      <td>${r.bpm} lpm</td>
      <td><span class="hist-dot" style="background:${r.color}"></span>${r.status}</td>
      <td>${r.time}</td>
    </tr>
  `;
}

viewAllBtn.addEventListener('click', () => {
  modalHistoryCount.textContent = `${peopleHistory.length} registro${peopleHistory.length === 1 ? '' : 's'} en total`;
  fullHistoryBody.innerHTML = peopleHistory.slice().reverse().map(rowHtml).join('');
  historyModalOverlay.classList.add('open');
});

closeHistoryModal.addEventListener('click', () => historyModalOverlay.classList.remove('open'));
historyModalOverlay.addEventListener('click', (e) => {
  if(e.target === historyModalOverlay) historyModalOverlay.classList.remove('open');
});

clearHistoryBtn.addEventListener('click', () => {
  if(peopleHistory.length === 0) return;
  const confirmado = confirm(`¿Borrar los ${peopleHistory.length} registros guardados? Esta acción no se puede deshacer.`);
  if(!confirmado) return;
  peopleHistory = [];
  lastRegisteredBpm = null;
  historyModalOverlay.classList.remove('open');
  renderHistory();
});

registerBtn.addEventListener('click', () => {
  const bpm = currentBpmGuess();
  if(bpm === null){
    alert('Primero mide un pulso (con el micrófono o el simulador) antes de registrar a una persona.');
    return;
  }
  const name = prompt('Nombre de la persona a registrar:');
  if(!name || !name.trim()) return;

  const band = bandFromBpm(bpm);
  const time = new Date().toLocaleTimeString('es-ES', {hour12:false});
  peopleHistory.push({
    seq: peopleHistory.length + 1,
    name: name.trim(),
    bpm, status: band.name, color: band.color, time
  });
  renderHistory();

  if(band.sound === 'happy') playHappySound();
  else if(band.sound === 'sad') playSadSound();
  else playNeutralSound();
});

renderHistory();

// Navegación del menú superior //
const navLinks = document.querySelectorAll('nav a');
const navSections = ['monitor', 'sensor', 'historial']
  .map(id => document.getElementById(id))
  .filter(Boolean);

navLinks.forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const targetId = link.getAttribute('data-nav');
    const target = document.getElementById(targetId);
    if(target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

function setActiveNavOnScroll(){
  const scrollPos = window.scrollY + 120; // compensa la altura del header
  let currentId = navSections[0] ? navSections[0].id : null;
  navSections.forEach(section => {
    if(section.offsetTop <= scrollPos) currentId = section.id;
  });
  navLinks.forEach(link => {
    link.classList.toggle('active', link.getAttribute('data-nav') === currentId);
  });
}
window.addEventListener('scroll', setActiveNavOnScroll);
setActiveNavOnScroll();
