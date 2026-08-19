const slider = document.getElementById('aqiSlider');
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

function bandFor(v){
  if(v<=50) return {name:'Buena', idx:0};
  if(v<=100) return {name:'Moderada', idx:1};
  if(v<=150) return {name:'Dañina p/ sensibles', idx:2};
  return {name:'Mala', idx:3};
}

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

/* ---------- Pulso por micrófono ---------- */
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
  micBtn.classList.add('active');
  micBtnLabel.textContent = 'Detener micrófono';
  micHint.textContent = 'Escuchando… mantén el micrófono cerca de tu pulso, quieto y en silencio.';
  resizeMicCanvas();
  loopMic();
}

function stopMic(){
  micActive = false;
  if(rafId) cancelAnimationFrame(rafId);
  if(micStream) micStream.getTracks().forEach(t=>t.stop());
  if(audioCtx) audioCtx.close();
  micBtn.classList.remove('active');
  micBtnLabel.textContent = 'Activar micrófono';
  micHint.textContent = 'Acerca el micrófono a tu muñeca o cuello, quieto y en silencio, para captar el pulso. El sonido ambiente no sirve para medirlo.';
  micBpmEl.innerHTML = '--<span>lat/min</span>';
  micCtx.clearRect(0,0,micCanvas.width, micCanvas.height);
}

micBtn.addEventListener('click', ()=>{ micActive ? stopMic() : startMic(); });

function loopMic(){
  if(!micActive) return;
  analyser.getByteTimeDomainData(dataArr);

  let sum = 0;
  for(let i=0;i<dataArr.length;i++){ sum += Math.abs((dataArr[i]-128)/128); }
  const frameAmp = sum/dataArr.length;
  envSmooth = envSmooth*0.85 + frameAmp*0.15;

  const now = performance.now();
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
      micBpmEl.innerHTML = `${bpm}<span>lat/min</span>`;
      if(micDrive.checked) updateFromMic(bpm);
    }
  }

  drawMicWave();
  rafId = requestAnimationFrame(loopMic);
}

function drawMicWave(){
  const w = micCanvas.width, h = micCanvas.height;
  micCtx.clearRect(0,0,w,h);
  micCtx.beginPath();
  const stateColor = getComputedStyle(document.documentElement).getPropertyValue('--state-color').trim() || '#56D6E0';
  micCtx.strokeStyle = stateColor;
  micCtx.lineWidth = 2*(window.devicePixelRatio||1);
  const slice = w/dataArr.length;
  let x = 0;
  for(let i=0;i<dataArr.length;i++){
    const y = (dataArr[i]/128.0)*h/2;
    if(i===0) micCtx.moveTo(x,y); else micCtx.lineTo(x,y);
    x += slice;
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

function tickClock(){
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString('es-ES', {hour12:false});
}
tickClock();
setInterval(tickClock, 1000);

// pequeña simulación ambiental automática, respetando lo que el usuario mueva manualmente
let auto = true;
slider.addEventListener('pointerdown', ()=> auto=false);
setInterval(()=>{
  if(!auto) return;
  const current = Number(slider.value);
  const next = Math.max(0, Math.min(300, current + (Math.random()*20-10)));
  slider.value = Math.round(next);
  update(slider.value);
}, 3000);

/* ---------- Sonidos de AIRO (feliz / neutral / triste) ---------- */
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

/* ---------- Historial de personas (máx. 10, luego se reinicia) ---------- */
const registerBtn = document.getElementById('registerBtn');
const historyBody = document.getElementById('historyBody');
const historyTable = document.getElementById('historyTable');
const historyEmpty = document.getElementById('historyEmpty');
const historyCount = document.getElementById('historyCount');
let peopleHistory = [];

function bandFromBpm(bpm){
  if(bpm < 60) return {name:'Tranquilo', color:'var(--good)', sound:'happy'};
  if(bpm <= 100) return {name:'Normal', color:'var(--warn)', sound:'neutral'};
  return {name:'Agitado', color:'var(--bad)', sound:'sad'};
}

// Usa el pulso real del micrófono si está activo y hay lectura válida;
// si no, cae de vuelta al pulso general mostrado en la tarjeta de vitales.
function currentBpmGuess(){
  const micVal = parseInt(micBpmEl.textContent, 10);
  if(micActive && !isNaN(micVal)) return micVal;
  const genVal = parseInt(bpmReading.textContent, 10);
  return isNaN(genVal) ? null : genVal;
}

function renderHistory(){
  historyCount.textContent = `${peopleHistory.length}/10 registros`;
  if(peopleHistory.length === 0){
    historyEmpty.style.display = 'block';
    historyTable.style.display = 'none';
    return;
  }
  historyEmpty.style.display = 'none';
  historyTable.style.display = 'table';
  historyBody.innerHTML = peopleHistory.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${r.name}</td>
      <td>${r.bpm} lpm</td>
      <td><span class="hist-dot" style="background:${r.color}"></span>${r.status}</td>
      <td>${r.time}</td>
    </tr>
  `).join('');
}

registerBtn.addEventListener('click', () => {
  const bpm = currentBpmGuess();
  if(bpm === null){
    alert('Primero mide un pulso (con el micrófono o el simulador) antes de registrar a una persona.');
    return;
  }
  const name = prompt('Nombre de la persona a registrar:');
  if(!name || !name.trim()) return;

  // Al llegar a 10 registros, el historial se reinicia y empieza de nuevo
  if(peopleHistory.length >= 10){
    peopleHistory = [];
  }

  const band = bandFromBpm(bpm);
  const time = new Date().toLocaleTimeString('es-ES', {hour12:false});
  peopleHistory.push({ name: name.trim(), bpm, status: band.name, color: band.color, time });
  renderHistory();

  if(band.sound === 'happy') playHappySound();
  else if(band.sound === 'sad') playSadSound();
  else playNeutralSound();
});

renderHistory();