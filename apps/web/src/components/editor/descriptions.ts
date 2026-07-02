export const DESCRIPTIONS: Record<string, string> = {
  // --- Inspector tabs ---
  primaries:
    'Classic lift / gamma / gain / offset controls. Lift sets the black point, ' +
    'gain the white point, gamma the midtones, and offset shifts the whole image. ' +
    'Use the wheels to colour-balance shadows and highlights independently — drag ' +
    'the puck to tint the tonal region. The master slider beneath each wheel ' +
    'adjusts overall brightness for that zone.',
  hdr:
    'HDR tonal-zone wheels, modelled after DaVinci Resolve\u2019s HDR palette. ' +
    'Four overlapping luma ranges \u2014 Dark, Shadow, Light, and Global \u2014 let you ' +
    'colour-balance specific luminance bands without affecting the rest. ' +
    'Dark targets the deepest shadows, Shadow the low mids, Light the highlights, ' +
    'and Global applies everywhere. Each zone uses a smooth luma mask so the ' +
    'transition between bands stays natural.',
  curves:
    'Per-channel tone curves for precise contrast and colour adjustments. ' +
    'The Y (luma) curve adjusts overall contrast; R, G, and B curves let you ' +
    'tint specific tonal ranges. Click to add a control point, drag to reshape, ' +
    'double-click a point to remove it. The histogram behind the luma curve ' +
    'shows the current frame\u2019s tonal distribution as a guide.',
  chroma:
    'A 2D hue-vs-hue and hue-vs-saturation control, like DaVinci\u2019s Color Warper. ' +
    'Six control points sit on the chroma wheel at the primary and secondary ' +
    'hues (red, yellow, green, cyan, blue, magenta). Drag a point around the ' +
    'wheel to shift that hue, or drag inward/outward to reduce or boost its ' +
    'saturation. The inner dashed shape is the neutral reference, the solid shape ' +
    'is the current warp. The blend between adjacent points is smooth, so changes ' +
    'stay natural across the hue spectrum.',

  // --- Color wheel bands ---
  lift:
    'Lift sets the black point \u2014 the darkest parts of the image. ' +
    'Drag the puck to tint blacks toward a colour. The master slider adjusts ' +
    'how much the black level is lifted (raising shadows) or crushed (deepening them).',
  gamma:
    'Gamma controls the midtones \u2014 the brightness range between shadows and ' +
    'highlights. Drag the puck to tint midtones. The master slider adjusts ' +
    'mid-range brightness: values above 1 darken mids, below 1 brighten them.',
  gain:
    'Gain sets the white point \u2014 the brightest parts of the image. ' +
    'Drag the puck to tint highlights. The master slider adjusts the white clip ' +
    'level: values above 1 reduce contrast by expanding highlights, below 1 ' +
    'crush them for a darker, moodier look.',
  offset:
    'Offset shifts the entire image brightness uniformly, without affecting ' +
    'contrast. Drag the puck to add a global colour cast. Useful for matching ' +
    'shots or adding a stylistic tint across the whole frame.',
  dark:
    'Dark zone \u2014 targets only the deepest shadows using a smooth luma mask. ' +
    'Tint the darkest regions or adjust their brightness without affecting ' +
    'midtones or highlights.',
  shadow:
    'Shadow zone \u2014 targets the low-mid luminance range between pure blacks ' +
    'and midtones. Use it to shape the transition area, often for adding ' +
    'warmth or coolness to shadow detail.',
  light:
    'Light zone \u2014 targets the high-mid luminance range between midtones and ' +
    'pure highlights. Good for adjusting skin-tone regions without blowing ' +
    'out the whites.',
  global:
    'Global zone \u2014 applies uniformly across the entire luminance range, ' +
    'but layered into the HDR zone system so it interacts with the other ' +
    'zones. Use it for a final overall colour tweak after dialling in ' +
    'the other zones.',

  // --- Curve channels ---
  luma_curve:
    'The luma (Y) curve controls overall brightness contrast. ' +
    'Steepen the midtones for more pop, pull down the shadows for deeper ' +
    'blacks, or roll off the highlights to protect them from clipping.',
  red_curve:
    'The red channel curve. Raising the curve adds red to that tonal range; ' +
    'lowering it subtracts red (adds cyan). Good for warming or cooling ' +
    'specific brightness zones.',
  green_curve:
    'The green channel curve. Raising it adds green; lowering it subtracts ' +
    'green (adds magenta). Often the most sensitive channel for skin tones.',
  blue_curve:
    'The blue channel curve. Raising it adds blue; lowering it subtracts ' +
    'blue (adds yellow). Useful for white-balance adjustments in specific ' +
    'tonal regions.',
  curve_smooth:
    'When enabled, the curve interpolates control points with a smooth ' +
    'Catmull-Rom spline instead of straight line segments. This produces ' +
    'softer, more film-like transitions and prevents hard banding.',

  // --- Chroma warp readout ---
  chroma_hue_shift:
    'Hue shift in degrees. Positive values rotate the hue clockwise on ' +
    'the colour wheel; negative values rotate counter-clockwise. The range ' +
    'is \u00b136\u00b0 per control point.',
  chroma_saturation:
    'Saturation multiplier for this hue sector. 1.0 is the original ' +
    'saturation; 0.0 is fully desaturated (greyscale); values above 1.0 ' +
    'boost saturation. The blend between adjacent sectors stays smooth.',

  // --- Scopes ---
  histogram:
    'A luminance histogram showing how many pixels fall at each brightness ' +
    'level, from pure black (left) to pure white (right). Use it to check ' +
    'exposure and identify clipping at the black and white points. ' +
    'R, G, B channels are overlaid as coloured traces.',
  waveform:
    'An RGB parade waveform \u2014 R, G, and B signal strength plotted side by ' +
    'side from black (bottom) to white (top), left to right across the ' +
    'frame. Use it to check channel balance, exposure uniformity, and ' +
    'whether skin tones fall in the right luminance range.',
  vectorscope:
    'A vectorscope plots chrominance on a polar colour wheel: hue is the ' +
    'angle, saturation the distance from the centre. Use it to evaluate ' +
    'colour casts, monitor skin-tone lines (they cluster around the ' +
    'red/yellow axis at ~58\u00b0), and check that you\u2019re not pushing any ' +
    'colour past broadcast-safe saturation limits.',
  rgbwave:
    'A luminance waveform \u2014 white trace from black (bottom) to white (top), ' +
    'left to right across the frame. Unlike the Parade, which splits R/G/B, ' +
    'this shows a single luma trace. Use it to check overall exposure ' +
    'consistency and spot bright or dark regions in the frame.',
  falsecolor:
    'False colour exposure assist: pixels below 0% clip are black, near-clip ' +
    'zones are magenta, 1-2 stops over are yellow, skin-tones (\u223c70% luma) ' +
    'are green, and shadow zones (<10%) are dark blue. Use it to quickly ' +
    'evaluate exposure without relying on a waveform reading.',
  clipping:
    'Clipping indicator: pixels that clip to pure black (0) or pure white (1) ' +
    'in any channel are highlighted in red. Use it to confirm no detail is ' +
    'lost to clipping before rendering.',

  // --- FX ---
  glow:
    'Glow blooms the bright regions of the image, like a lens flare or ' +
    'pro-mist filter. It bright-passes pixels above a threshold, blurs ' +
    'them, and adds them back. Use it for a dreamy, cinematic look or to ' +
    'add atmosphere to highlights.',
  halation:
    'Halation simulates the warm red/orange glow that film gets around ' +
    'bright highlights when light scatters through the emulsion. Most ' +
    'visible on high-contrast edges like light sources against dark ' +
    'backgrounds. Screen-blended so it rolls off softly.',
  blur:
    'A simple box blur. Averages neighbouring pixels over a radius and ' +
    'mixes the result back with the original. Useful for softening an ' +
    'image, creating depth-of-field effects, or as a pre-process for ' +
    'other effects.',
  sharpen:
    'Unsharp mask: subtracts a blurred copy from the image to recover ' +
    'high-frequency detail, scaled by the amount. Use it to bring back ' +
    'detail lost in grading or to give a crisper look. Watch for ' +
    'artefacts at high amounts or large radii.',
  'film-look':
    'An analytic film-stock emulation that approximates the classic film ' +
    'look: a filmic S-curve (toe + shoulder), gentle desaturation with ' +
    'highlight bleach, a teal/orange split tone, and a film-density black ' +
    'lift. Pair with Halation and grain for the full celluloid effect.',
  'split-tone':
    'Split tone tints shadows and highlights with independent hues, ' +
    'crossing over at a balance point. The classic teal/orange cinematic ' +
    'look: make shadows teal and highlights orange. Shadow and highlight ' +
    'hue are set independently, with separate strength controls.',
  'color-space':
    'Colour space transform: converts from camera-native log/gamut to ' +
    'the working colour space (Rec.709 or similar). This is the first ' +
    'step in any log-to-graded pipeline \u2014 it normalises the image so the ' +
    'corrector wheels and curves work on a standardised signal.',
  lut:
    'Applies a 3D colour lookup table (.cube file). Load a LUT from a ' +
    'built-in preset or your own .cube file. The amount slider dials ' +
    'the LUT\u2019s effect from subtle (below 1.0) to full strength (1.0). ' +
    'Use LUTs for technical transforms (log-to-Rec709) or creative looks.',

  // --- Node graph ---
  'grade-node':
    'A corrector node in the grading graph. Each node carries a full set ' +
    'of colour tools \u2014 Primaries, HDR, Curves, and Chroma Warp \u2014 plus a ' +
    'stackable FX chain. Connect nodes in series: the output of one feeds ' +
    'into the input of the next. Select a node to edit it in the Inspector.',
}
