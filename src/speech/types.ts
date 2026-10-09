export interface SpokenAudio {
  audio: Buffer;
  contentType: string;
}

export interface SpeechSynthesizer {
  speak(text: string): Promise<SpokenAudio>;
}
