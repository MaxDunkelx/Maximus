declare module 'msedge-tts' {
  import type { Readable } from 'node:stream';

  export enum OUTPUT_FORMAT {
    AUDIO_24KHZ_48KBITRATE_MONO_MP3 = 'audio-24khz-48kbitrate-mono-mp3',
    AUDIO_24KHZ_96KBITRATE_MONO_MP3 = 'audio-24khz-96kbitrate-mono-mp3',
    WEBM_24KHZ_16BIT_MONO_OPUS = 'webm-24khz-16bit-mono-opus',
  }

  export class MsEdgeTTS {
    setMetadata(voiceName: string, outputFormat: OUTPUT_FORMAT): Promise<void>;
    toStream(
      input: string,
      options?: { pitch?: string; rate?: string; volume?: string },
    ): { audioStream: Readable };
    close(): void;
  }
}
