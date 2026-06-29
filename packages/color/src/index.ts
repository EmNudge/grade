export * from './matrices'
export * from './transfer'
export * from './wgsl'

/** Camera source color spaces Grade can decode to Rec.709 out of the box. */
export type SourceColorSpace =
  | 'dji-dlog' // DJI D-Log / D-Log M (D-Gamut analytic path)
  | 'sony-slog3' // Sony S-Log3 / S-Gamut3.Cine
  | 'arri-logc3' // ARRI LogC3 (EI 800) / AWG3
  | 'rec709' // already Rec.709 — passthrough, no transform

/** Display encodings the output transform can target. */
export type DisplayEncode = 'bt709' | 'gamma24' | 'gamma22'
