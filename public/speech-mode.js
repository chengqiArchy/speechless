export function resolveSpeechMode({ remoteMode, localMode, configuringClonedVoice = false }) {
  if (configuringClonedVoice) return localMode === 'cloned' ? 'cloned' : 'device';
  return remoteMode === 'cloned' ? 'cloned' : 'device';
}
