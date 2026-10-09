import { describe, expect, it } from 'vitest';
import { prosodyFor, spokenText } from '../src/speech/edge.js';

describe('spoken text', () => {
  it('escapes markup and keeps a single line', () => {
    expect(spokenText('  Strength & honor.\n<script> ')).toBe('Strength &amp; honor. &lt;script&gt;');
  });

  it('speaks the profession shout louder and faster', () => {
    expect(prosodyFor('Ahoo! Ahoo! Ahoo!')).toMatchObject({ rate: '+30%', volume: '+50%' });
    expect(prosodyFor('My name is Maximus Decimus Meridius, a loyal servant of Maximus Dunkel.')).toMatchObject({
      rate: '+0%',
    });
  });
});