#!/usr/bin/env python3
"""Inspect actual PPTX package links, geometry and font availability (no third-party deps).
Text fit is an estimate, not proof; rendered PNG review is still required.
"""
import argparse
import json
import posixpath
import re
import subprocess
import sys
import zipfile
from functools import lru_cache
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
      'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
EMU = 914400

@lru_cache(maxsize=128)
def font_info(family):
    try:
        result = subprocess.run(['fc-match', '-f', '%{family}\n%{file}', family], capture_output=True, text=True, check=True, timeout=5).stdout.splitlines()
        resolved = result[0] if result else ''
        normalize = lambda s: re.sub(r'[\s_-]', '', s).casefold()
        exact = normalize(family) in [normalize(s) for s in resolved.split(',')]
        return {'requested': family, 'resolved': resolved, 'available': exact, 'file': result[1] if len(result) > 1 else ''}
    except (OSError, subprocess.SubprocessError):
        return {'requested': family, 'available': None, 'resolved': 'fontconfig unavailable'}

@lru_cache(maxsize=256)
def measure_font(family, points):
    try:
        from PIL import ImageFont
        return ImageFont.truetype(font_info(family).get('file', ''), max(1, round(points * 4)))
    except (ImportError, OSError):
        return None

def text_width(text, family, points):
    font = measure_font(family, points)
    if font:
        return font.getlength(text) / 4 / 72
    return sum(1 if ord(c) > 255 else .56 for c in text) * points / 72

def run_font(run, default_font):
    txt = run.find('a:t', NS)
    txt = txt.text or '' if txt is not None else ''
    props = run.find('a:rPr', NS)
    if props is not None:
        face = props.find('a:ea' if any(ord(c)>255 for c in txt) else 'a:latin', NS)
        if face is None: face = props.find('a:latin', NS)
        if face is not None and face.get('typeface') and not face.get('typeface').startswith('+'):
            return face.get('typeface')
    return default_font

def audit(path):
    errors, warnings, font_reports = [], [], {}
    def issue(target, page, element, code, message):
        target.append({'slide': page, 'element': element, 'code': code, 'message': message})
    with zipfile.ZipFile(path) as z:
        bad = z.testzip()
        if bad: raise ValueError('Corrupt ZIP member: ' + bad)
        names = set(z.namelist())
        for required in ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml']:
            if required not in names: raise ValueError('Missing ' + required)
        xmls = {}
        for name in names:
            if name.endswith(('.xml', '.rels')):
                try: xmls[name] = ET.fromstring(z.read(name))
                except ET.ParseError: issue(errors, None, name, 'invalid_xml', 'Invalid XML')
        for name, root in xmls.items():
            if not name.endswith('.rels'): continue
            folder = posixpath.dirname(posixpath.dirname(name))
            for rel in root:
                if rel.get('TargetMode') == 'External': continue
                target = rel.get('Target', '')
                resolved = posixpath.normpath(posixpath.join(folder, target)).lstrip('/')
                if resolved not in names:
                    issue(errors, None, name, 'broken_relationship', 'Missing target: ' + resolved)
        pres = xmls.get('ppt/presentation.xml')
        if pres is None: raise ValueError('Invalid presentation XML')
        size = pres.find('p:sldSz', NS)
        if size is None: raise ValueError('Missing slide size')
        width, height = int(size.get('cx')) / EMU, int(size.get('cy')) / EMU
        rel_root = xmls.get('ppt/_rels/presentation.xml.rels')
        rels = {r.get('Id'): posixpath.normpath(posixpath.join('ppt', r.get('Target', ''))).lstrip('/') for r in rel_root} if rel_root is not None else {}
        ids = pres.findall('p:sldIdLst/p:sldId', NS)
        slides = [rels.get(i.get('{%s}id' % NS['r'])) for i in ids]
        if not slides: issue(errors, None, '', 'empty_deck', 'No slides in presentation order')
        default_font = 'Arial'
        theme = xmls.get('ppt/theme/theme1.xml')
        if theme is not None:
            f = theme.find('.//a:minorFont/a:latin', NS)
            if f is not None and f.get('typeface'): default_font = f.get('typeface')
        for page, name in enumerate(slides, 1):
            root = xmls.get(name)
            if root is None:
                issue(errors, page, str(name), 'missing_slide', 'Slide is not resolvable'); continue
            # Font availability applies to all native runs, including table cells
            # and grouped text, independently of the geometry/fit checks below.
            for run in root.findall('.//a:r', NS):
                txt = run.find('a:t', NS)
                if txt is None or not (txt.text or '').strip(): continue
                fam = run_font(run, default_font)
                info = font_info(fam)
                font_reports[fam] = {k:v for k,v in info.items() if k != 'file'}
            tree = root.find('p:cSld/p:spTree', NS)
            if tree is None: continue
            boxes = []
            for idx, shape in enumerate(tree):
                if shape.tag.endswith('grpSp'):
                    issue(warnings, page, str(idx), 'group_geometry_unchecked', 'Grouped transforms need rendered review'); continue
                xfrm = shape.find('p:spPr/a:xfrm', NS)
                if xfrm is None: xfrm = shape.find('p:xfrm', NS)
                if xfrm is None: continue
                off, ext = xfrm.find('a:off', NS), xfrm.find('a:ext', NS)
                if off is None or ext is None: continue
                x, y = int(off.get('x', '0')) / EMU, int(off.get('y', '0')) / EMU
                w, h = int(ext.get('cx', '0')) / EMU, int(ext.get('cy', '0')) / EMU
                text = ''.join(e.text or '' for e in shape.findall('.//a:t', NS))
                identity = shape.find('.//p:cNvPr', NS)
                label = identity.get('name', str(idx)) if identity is not None else str(idx)
                rotated = int(xfrm.get('rot', '0')) % 21600000 != 0
                if rotated:
                    issue(warnings, page, label, 'rotation_unchecked', 'Rotated object needs rendered bounds review')
                elif x < -.02 or y < -.02 or x+w > width+.02 or y+h > height+.02:
                    issue(errors, page, label, 'out_of_bounds', 'Object extends beyond slide canvas')
                if text:
                    boxes.append((x,y,w,h,label))
                    if re.search(r'\b(?:lorem ipsum|TODO|\[insert\b)', text, re.I):
                        issue(warnings, page, label, 'placeholder', 'Possible leftover placeholder text')
                    body = shape.find('p:txBody', NS)
                    if body is None: continue
                    bodypr = body.find('a:bodyPr', NS)
                    margins = {key: int(bodypr.get(key, str(default))) / EMU if bodypr is not None else default/EMU for key,default in [('lIns',91440),('rIns',91440),('tIns',45720),('bIns',45720)]}
                    available_w = max(.01,w-margins['lIns']-margins['rIns'])
                    total_height = 0
                    small_body_sizes = []
                    for para in body.findall('a:p', NS):
                        pts, fam = 0., default_font
                        line_width, lines = 0., 1
                        for child in para:
                            if child.tag == '{%s}br' % NS['a']: lines += 1; line_width = 0
                            if child.tag != '{%s}r' % NS['a']: continue
                            rp = child.find('a:rPr', NS)
                            run_pts = int(rp.get('sz', '1800'))/100 if rp is not None else 18.
                            pts = max(pts, run_pts)
                            txt = child.find('a:t', NS); txt = txt.text or '' if txt is not None else ''
                            if run_pts < 18 and len(txt.strip()) >= 24 and y < height-.8:
                                small_body_sizes.append(run_pts)
                            fam = run_font(child, default_font)
                            for ch in txt:
                                cw = text_width(ch,fam,run_pts)
                                if line_width+cw>available_w and line_width>0: lines+=1;line_width=0
                                line_width+=cw
                        total_height += lines * (pts or 18.) * 1.15 / 72
                    if small_body_sizes:
                        issue(warnings,page,label,'small_body_text',
                              'Long text uses '+str(min(small_body_sizes))+'pt; review at presentation scale. Prefer 18–24pt for ordinary body copy, or document why this is a caption/compact label.')
                    if not rotated and total_height > max(.01,h-margins['tIns']-margins['bIns'])*1.12:
                        issue(warnings,page,label,'text_fit_estimate', 'Text may exceed its box; verify the rendered page or shorten/split content')
            for i,a in enumerate(boxes):
                for b in boxes[i+1:]:
                    ox,oy=min(a[0]+a[2],b[0]+b[2])-max(a[0],b[0]),min(a[1]+a[3],b[1]+b[3])-max(a[1],b[1])
                    if ox>.05 and oy>.05:
                        issue(warnings,page,a[4]+' / '+b[4],'text_overlap','Text box regions overlap; inspect whether intentional')
        for f,info in font_reports.items():
            if info['available'] is not True:
                issue(warnings,None,f,'font_unavailable','Requested font is missing or cannot be verified; fontconfig resolves to '+info['resolved'])
        return {'valid':not errors,'slideCount':len(slides),'errors':errors,'warnings':warnings,'fonts':list(font_reports.values()),
                'limitations':['Text fit is estimated; review rendered PNGs.', 'Fontconfig resolution is not proof of the font PowerPoint will use on another computer.', 'Grouped/rotated geometry and master placeholders require rendered review.']}

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('pptx');ap.add_argument('--output');ap.add_argument('--strict-fonts',action='store_true')
    args=ap.parse_args()
    try: result=audit(args.pptx)
    except (ValueError,TypeError,KeyError,OSError,zipfile.BadZipFile) as e: result={'valid':False,'errors':[{'code':'package_error','message':str(e)}]}
    if args.strict_fonts and any(w['code']=='font_unavailable' for w in result.get('warnings',[])): result['valid']=False
    output=json.dumps(result,ensure_ascii=False,indent=2)
    if args.output: Path(args.output).write_text(output+'\n',encoding='utf-8')
    print(output)
    return 0 if result['valid'] else 1

if __name__=='__main__':sys.exit(main())
