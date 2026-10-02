"""Fetch one public NIST carving image and independent original documents.
No archives are extracted by path. Bzip2 is streamed into one bounded owned file.
"""
import bz2, datetime, hashlib, json, mmap, os, shutil, sys, urllib.request
from pathlib import Path
root = Path(sys.argv[1]).resolve(); root.mkdir(parents=True, exist_ok=False)
base = 'https://cfreds-archive.nist.gov/FileCarving/'
if shutil.disk_usage(root).free < 3 * 1024**3: raise RuntimeError('Less than 3 GiB free')
receipts = []
def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()
def fetch(relative, target):
    url = base + relative
    request=urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
    with urllib.request.urlopen(request, timeout=60) as response, target.open('xb') as f:
        size = 0
        while b := response.read(1024*1024):
            size += len(b)
            if size > 64 * 1024**2: raise RuntimeError('Download exceeded 64 MiB limit')
            f.write(b)
        f.flush(); os.fsync(f.fileno())
    receipts.append({'url':url,'path':str(target),'size':size,'sha256':digest(target),
                     'retrievedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()})
compressed = root/'L0_Documents.dd.bz2'; fetch('Images/L0_Documents.dd.bz2',compressed)
image = root/'L0_Documents.dd'
with bz2.open(compressed,'rb') as source, image.open('xb') as target:
    size=0
    while b := source.read(1024*1024):
        size+=len(b)
        if size > 2*1024**3: raise RuntimeError('Image exceeded 2 GiB limit')
        target.write(b)
    target.flush(); os.fsync(target.fileno())
(root/'originals').mkdir();targets=[]
for name in ['D1.pdf','D2.pdf','D3.xlsx','D4.xlsx','D5.docx','D6.docx','D7.pptx']:
    file=root/'originals'/name; fetch('TestFiles/Document/'+name,file)
    body=file.read_bytes()
    with image.open('rb') as f, mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ) as view:
        position=view.find(body)
    # A mismatched public corpus is a preparation failure, not an engine failure.
    if position<0: raise RuntimeError(f'Public original {name} is not intact in published L0 image')
    targets.append({'id':'nist-carving-'+name,'name':name,'kind':file.suffix[1:],'size':len(body),
                    'sha256':digest(file),'originalFile':str(file),'originalPath':name,
                    'independentlyLocatedOffset':position,
                    'expected':{'deepExact':True,'bodyIntact':True}})
imagehash=digest(image)
plan={'version':1,'cases':[{'id':'nist-l0-documents','cohort':'development','input':str(image),
       'inputSha256':imagehash,'size':size,'modes':['deep-whole']} ]}
oracle={'version':1,'cases':[{'id':'nist-l0-documents','sourceSha256':imagehash,'targets':targets,
         'oracleBasis':'Separately downloaded NIST original files, verified intact in L0 image before engine execution'}]}
(root/'plan.json').write_text(json.dumps(plan,indent=2),encoding='utf-8')
(root/'answers.json').write_text(json.dumps(oracle,indent=2),encoding='utf-8')
(root/'download-receipts.json').write_text(json.dumps({'downloads':receipts,'image':{'path':str(image),'size':size,'sha256':imagehash}},indent=2),encoding='utf-8')
print(json.dumps({'imageSize':size,'originals':len(targets),'imageSha256':imagehash}))
