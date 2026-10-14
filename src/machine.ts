// The xTool S1 40 W model and the one material the settings are tuned for.
// Values come from jobs xTool Studio 1.9.11 sent to this machine. All lengths in mm.

/** usable label area from Studio's max-bed capture: X 0–498 mm, Y 0–319 mm */
export const bed = { width: 498, height: 319 }

export const material = '3 mm plywood'
/** head height the S1 measured on that plywood; other materials or supports need a new measurement */
export const focusZ = 52.541

/** X acceleration (M32 X3200); the bitmap run-up v²/2a lets the head reach full speed before burning */
export const acceleration = 3200

export interface LayerSettings {
  /** percent */
  power: number
  /** mm/s */
  speed: number
}

export interface LaserSettings {
  engrave: LayerSettings
  pattern: LayerSettings
  cut: LayerSettings
  /** mm between bitmap engraving scanlines */
  lineSpacing: number
}

export const plywoodSettings: LaserSettings = {
  engrave: { power: 25, speed: 200 },
  pattern: { power: 20, speed: 100 },
  cut: { power: 100, speed: 15 },
  lineSpacing: 0.1,
}

/**
 * M222 device states; the S1 also pushes them on its own. 4–22 are named in Studio's help
 * links, the others are read from captured jobs.
 */
export const deviceStates: Record<number, string> = {
  3: 'Ready',
  4: 'The machine was moved',
  7: 'Lid open – close it',
  9: 'Flame detected!',
  10: 'Measuring',
  13: 'Press the button on the S1 to start',
  14: 'Engraving and cutting…',
  19: 'Done',
  20: 'Position limit reached',
  21: 'Wi-Fi problem',
  22: 'Laser problem',
}
