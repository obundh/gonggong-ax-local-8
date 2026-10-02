"""Deterministic, non-confidential document corpus for recovery qualification.

Only writes a new output directory. It never deletes files or touches a volume.
Validation is format parsing, not an assertion that Word/Acrobat opened the file.
"""
import datetime, hashlib, io, json, sys, zipfile
from pathlib import Path
from xml.sax.saxutils import escape
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject
from docx import Document

root = Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=False)
rows = []
for cohort, seed in [('development', 'DEV-0920'), ('evaluation', 'EVAL-7F3A')]:
    for kind in ['txt', 'pdf', 'docx']:
        for level, count in [('small', 64), ('medium', 16384), ('large', 1040384)]:
            key = f'{cohort}-{kind}-{level}'
            token = f'Qualification {seed} {kind} {level}. '
            content = (token * (count // len(token) + 1))[:count]
            if kind == 'txt':
                data = content.encode('utf-8')
                assert data.decode('utf-8') == content
                proof = {'utf8Decoded': True, 'characters': len(content)}
            elif kind == 'pdf':
                writer = PdfWriter()
                page = writer.add_blank_page(width=595, height=842)
                stream = DecodedStreamObject()
                # A legal no-op graphics stream plus a deterministic comment.
                stream.set_data(b'q\nQ\n% ' + content.encode('ascii') + b'\n')
                page[NameObject('/Contents')] = writer._add_object(stream)
                writer.add_metadata({'/Title': key, '/Producer': 'RecoveryChat qualification fixture'})
                output = io.BytesIO(); writer.write(output); data = output.getvalue()
                parsed = PdfReader(io.BytesIO(data), strict=True)
                assert len(parsed.pages) == 1 and parsed.pages[0].get_contents().get_data() == stream.get_data()
                proof = {'pagesParsed': 1, 'contentStreamExact': True, 'visibleContent': 'blank-page-with-test-stream'}
            else:
                xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                       '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                       '<w:body><w:p><w:r><w:t xml:space="preserve">' + escape(content) +
                       '</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')
                parts = {
                    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
                    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
                    'word/document.xml': xml,
                }
                output = io.BytesIO()
                with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_STORED) as z:
                    for name, value in sorted(parts.items()):
                        z.writestr(zipfile.ZipInfo(name, (2000, 1, 1, 0, 0, 0)), value.encode('utf-8'))
                data = output.getvalue()
                parsed = Document(io.BytesIO(data))
                assert '\n'.join(p.text for p in parsed.paragraphs) == content
                proof = {'docxXmlParsed': True, 'paragraphTextExact': True}
            # Same basenames in distinct directories, Korean and long filenames.
            name = f'회의자료.{kind}' if level != 'large' else f'공공업무_장기보관_문서구조_한글이름_원본대조_시험자료_{kind}.{kind}'
            folder = root / cohort / kind / level
            folder.mkdir(parents=True)
            file = folder / name
            with file.open('xb') as target:
                target.write(data); target.flush()
                import os
                os.fsync(target.fileno())
            assert file.read_bytes() == data
            rows.append({'id': key, 'cohort': cohort, 'kind': kind, 'level': level,
                         'name': name, 'path': str(file), 'size': len(data),
                         'sha256': hashlib.sha256(data).hexdigest(), 'validation': proof})
manifest = {'version': 1, 'synthetic': True, 'scope': 'Parser-qualified test documents; no physical deletion',
            'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'files': rows}
(root / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'files': len(rows), 'root': str(root)}, ensure_ascii=True))
