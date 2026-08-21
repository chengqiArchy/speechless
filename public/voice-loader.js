export function watchAvailableVoices(
  synthesizer,
  onVoices,
  { pollIntervals = [50, 150, 350, 750, 1500, 3000] } = {},
) {
  let lastSignature;
  let stopped = false;
  const timers = [];
  const refresh = () => {
    if (stopped) return;
    const voices = synthesizer.getVoices();
    const signature = voices.map((voice) => `${voice.voiceURI}\u0000${voice.lang}\u0000${voice.name}`).join('\u0001');
    if (signature !== lastSignature) {
      lastSignature = signature;
      onVoices(voices);
    }
  };

  refresh();
  synthesizer.addEventListener('voiceschanged', refresh);
  for (const delay of pollIntervals) timers.push(setTimeout(refresh, delay));

  return () => {
    stopped = true;
    timers.forEach(clearTimeout);
    synthesizer.removeEventListener('voiceschanged', refresh);
  };
}
