import { Readable } from 'node:stream';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { AppError } from '../errors.js';
import { PROFESSION_REPLY } from '../orchestration/instructions.js';
import type { SpeechSynthesizer, SpokenAudio } from './types.js';

const VOICE = 'en-US-ChristopherNeural';
const MAX_CHARS = 1800;
const REGULAR_PROSODY = { rate: '+0%', pitch: '-4Hz' };
const SHOUT_PROSODY = { rate: '+30%', pitch: '-4Hz', volume: '+50%' };

export function prosodyFor(line: string): { rate: string; pitch: string; volume?: string } {
  return line === spokenText(PROFESSION_REPLY) ? SHOUT_PROSODY : REGULAR_PROSODY;
}

export function spokenText(input: string): string {
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHARS);
}

export class EdgeNeuralSpeaker implements SpeechSynthesizer {
  private client: MsEdgeTTS | null = null;
  private ready: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();

  speak(text: string): Promise<SpokenAudio> {
    const line = spokenText(text);
    if (!line) return Promise.reject(new AppError('validation_error', 'There is nothing to speak.', 400));
    const job = this.queue.then(() => this.synthesize(line));
    this.queue = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  private async synthesize(text: string): Promise<SpokenAudio> {
    try {
      await this.ensure();
      const { audioStream } = this.client!.toStream(text, prosodyFor(text));
      const audio = await readAll(audioStream);
      if (audio.length < 128) throw new AppError('speech_unavailable', 'The neural voice returned no audio.', 502);
      return { audio, contentType: 'audio/mpeg' };
    } catch (error) {
      this.client?.close();
      this.client = null;
      this.ready = null;
      if (error instanceof AppError) throw error;
      throw new AppError('speech_unavailable', 'The neural voice could not be reached.', 502);
    }
  }

  private ensure(): Promise<void> {
    if (!this.ready) {
      const client = new MsEdgeTTS();
      this.client = client;
      this.ready = client.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    }
    return this.ready;
  }
}

function readAll(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new AppError('speech_unavailable', 'The neural voice timed out.', 502));
    }, 20_000);
    stream.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
