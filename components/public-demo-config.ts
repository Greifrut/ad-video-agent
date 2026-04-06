export const FIXTURE_SAMPLE_BRIEF = [
  "Create a 10-second Deal Pump social ad that opens on the approved wordmark over the studio backdrop,",
  "cuts to the approved can packshot with energetic motion, and closes with a strong CTA.",
  "Keep it punchy, premium, and obviously derived from approved brand assets.",
].join(" ");

export const LIVE_SAMPLE_BRIEF = [
  "Create a short 4:9 vertical product video for Deal Pump in a clean modern studio.",
  "Scene 1: presenter introduces the product with natural hand gestures and calm studio movement.",
  "Scene 2: show the product interface in use on a device with smooth motion. Scene 3: show a simple positive lifestyle moment.",
  "Scene 4: end on a clean product-focused closing frame with space for later CTA text, keeping the total video under 10 seconds.",
].join(" ");

export function sampleBriefForMode(fixtureMode: boolean): string {
  return fixtureMode ? FIXTURE_SAMPLE_BRIEF : LIVE_SAMPLE_BRIEF;
}

export function defaultFixtureModeForEnvironment(nodeEnv: string | undefined): boolean {
  return nodeEnv !== "production";
}
