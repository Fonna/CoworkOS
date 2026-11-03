"""Encode the 120 deterministic TechText frames into a six-second README GIF."""
import argparse
import shutil
from pathlib import Path
from PIL import Image, ImageChops, ImageStat

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('frames', type=Path)
parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'assets/readme-hero.gif')
args = parser.parse_args()
paths = sorted(args.frames.glob('frame-*.png'))
if len(paths) != 120:
    parser.error(f'Expected 120 frames, found {len(paths)}')
frames = [Image.open(path).convert('RGB') for path in paths]
if any(frame.size != (1440, 480) for frame in frames):
    parser.error('Every frame must be 1440 × 480')
# A shared palette keeps the OS color transition and background stable.
samples = Image.new('RGB', (1440, 960))
for i, index in enumerate([0, 12, 24, 36, 48, 60, 72, 100]):
    samples.paste(frames[index].resize((720, 240)), ((i % 2) * 720, (i // 2) * 240))
palette = samples.quantize(colors=253, method=Image.Quantize.MEDIANCUT)
# Reserve exact classic window-control colors; these tiny areas must not be
# swallowed by the much larger blue/lilac gradient during palette generation.
colors = palette.getpalette()[:253 * 3] + [255, 95, 87, 254, 188, 46, 40, 200, 64]
palette.putpalette(colors)
quantized = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
args.output.parent.mkdir(parents=True, exist_ok=True)
quantized[0].save(args.output, save_all=True, append_images=quantized[1:], duration=50, loop=0, disposal=1, optimize=True)
shutil.copyfile(args.frames / 'static.png', args.output.with_suffix('.png'))
with Image.open(args.output) as result:
    duration = 0
    for index in range(result.n_frames):
        result.seek(index)
        duration += result.info.get('duration', 0)
    assert duration == 6000
    assert result.info.get('loop') == 0
    print(f'GIF: {result.size}, {result.n_frames} frames, {duration} ms, infinite loop')
print(f'Size: {args.output.stat().st_size / 1024 / 1024:.2f} MiB')
difference = ImageStat.Stat(ImageChops.difference(frames[0], frames[-1]))
print(f'Loop boundary mean RGB difference: {sum(difference.mean) / 3:.4f}/255')
contact = Image.new('RGB', (1440, 960))
for position, index in enumerate([0, 12, 24, 36, 48, 60, 72, 100]):
    contact.paste(frames[index].resize((720, 240)), ((position % 2) * 720, (position // 2) * 240))
contact.save(args.frames / 'contact.png')
