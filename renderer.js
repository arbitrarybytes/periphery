const { ipcRenderer } = require('electron');

const container = document.getElementById('cue-container');

ipcRenderer.on('trigger-cue', (event, { cue, color, msg, icon, repeats = 3, verbose = true }) => {
  if (cue === 'comet') {
    triggerComet(color);
  } else {
    triggerGlow(color, `cue-${cue}`, repeats);
  }
  
  if (msg && verbose !== false) {
    triggerText(msg, color, icon);
  }
});

function triggerGlow(color, className, repeats) {
  const glowEl = document.createElement('div');
  glowEl.classList.add(className);
  
  if (color) {
    glowEl.style.setProperty('--glow-color', color);
  }

  if (repeats && className.includes('glow-pulse')) {
    glowEl.style.animationIterationCount = repeats;
  }
  
  container.appendChild(glowEl);

  // Determine timeout based on repeats and animation duration
  // glow-pulse is 1.5s per repeat. We add 100ms padding.
  let duration = 4000; // Default for breathe
  if (className.includes('glow-pulse')) {
    duration = (1500 * repeats) + 100;
  }

  // Remove element after animation completes
  setTimeout(() => {
    glowEl.remove();
  }, duration);
}

function triggerComet(color) {
  const cometEl = document.createElement('div');
  cometEl.classList.add('cue-comet');
  
  if (color) {
    cometEl.style.boxShadow = `-20px 0 30px 10px ${color}`;
  }

  // Randomize vertical position slightly so they aren't all exactly on the same line
  const randomY = Math.floor(Math.random() * 200) + 50; 
  cometEl.style.top = `${randomY}px`;
  
  container.appendChild(cometEl);

  // Remove element after animation completes (8s)
  setTimeout(() => {
    cometEl.remove();
  }, 8100);
}

function triggerText(msg, color, iconUrl) {
  const textEl = document.createElement('div');
  textEl.classList.add('cue-text');
  
  if (iconUrl) {
    const img = document.createElement('img');
    img.src = iconUrl;
    img.style.width = '24px';
    img.style.height = '24px';
    img.style.borderRadius = '4px'; // Slight curve for square icons
    textEl.appendChild(img);
  } else if (color) {
    textEl.classList.add('has-dot');
    textEl.style.setProperty('--text-color', color);
  }

  const span = document.createElement('span');
  span.innerText = msg;
  textEl.appendChild(span);

  container.appendChild(textEl);

  setTimeout(() => {
    textEl.remove();
  }, 6100);
}
