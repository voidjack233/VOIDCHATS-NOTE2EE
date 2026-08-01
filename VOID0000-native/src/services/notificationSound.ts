import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';

const soundSource = require('../../assets/notification.mp3');
let player: ReturnType<typeof createAudioPlayer> | null = null;
let audioModePromise: Promise<void> | null = null;

async function prepareAudio() {
  audioModePromise ||= setAudioModeAsync({
    playsInSilentMode: false,
    interruptionMode: 'mixWithOthers',
    allowsRecording: false,
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
  });
  await audioModePromise;
  player ||= createAudioPlayer(soundSource, {
    keepAudioSessionActive: false,
  });
  return player;
}

export async function playNotificationSound() {
  const sound = await prepareAudio();
  if (sound.playing || sound.currentTime > 0) await sound.seekTo(0);
  sound.play();
}
