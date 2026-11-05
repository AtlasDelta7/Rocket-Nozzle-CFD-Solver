# Rebuilds "../Plume Lab.html" from the modules in this folder.
# Usage:  python build.py
import pathlib
here = pathlib.Path(__file__).resolve().parent
html = (here / 'index.html').read_text(encoding='utf-8')
parts = []
for f in ['physics.js', 'cutcell.js', 'solver.js', 'simsetup.js', 'render.js', 'app.js']:
    parts.append(f'// ===== {f} =====\n' + (here / f).read_text(encoding='utf-8'))
js = '\n'.join(parts).replace('</script>', '<\\/script>')
out = html.replace('<!--SCRIPTS-->', '<script>\n' + js + '\n</script>')
(here.parent / 'Plume Lab.html').write_text(out, encoding='utf-8')
print('Built', here.parent / 'Plume Lab.html', f'({len(out)//1024} KB)')
