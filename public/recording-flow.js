export async function beginRecording(recorder, { onRequesting, onStarted }) {
  onRequesting();
  await recorder.start();
  onStarted();
}
