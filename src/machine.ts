// The xTool S1 (10/20 W module) and the one material the settings are tuned for.
// Values come from jobs xTool Studio 1.9.11 sent to this machine. All lengths in mm.

/** laser work area (M223 X498 Y330 in Studio's jobs) */
export const bed = { width: 498, height: 330 }

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
}

export const plywoodSettings: LaserSettings = {
  engrave: { power: 25, speed: 200 },
  pattern: { power: 20, speed: 100 },
  cut: { power: 100, speed: 15 },
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
