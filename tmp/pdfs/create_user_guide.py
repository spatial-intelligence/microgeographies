from pathlib import Path
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from pypdf import PdfReader

root = Path(__file__).resolve().parents[2]
out = root / 'output/pdf/MicroGeog_Mapper_User_Guide.pdf'
out.parent.mkdir(parents=True, exist_ok=True)
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='GuideTitle', fontName='Helvetica-Bold', fontSize=25, leading=29, textColor=colors.HexColor('#14374B'), spaceAfter=9))
styles.add(ParagraphStyle(name='GuideSub', fontName='Helvetica', fontSize=10, leading=15, textColor=colors.HexColor('#526673'), spaceAfter=16))
styles.add(ParagraphStyle(name='GuideH', fontName='Helvetica-Bold', fontSize=13, leading=17, textColor=colors.HexColor('#14374B'), spaceBefore=13, spaceAfter=7))
styles.add(ParagraphStyle(name='GuideBody', fontName='Helvetica', fontSize=10, leading=14, spaceAfter=7))
styles.add(ParagraphStyle(name='GuideSmall', fontName='Helvetica', fontSize=9, leading=12, spaceAfter=5))
story = []
def p(text, style='GuideBody'):
    return Paragraph(text, styles[style])
def add(text, style='GuideBody'):
    story.append(p(text, style))
def h(text): add(text, 'GuideH')
def step(n, text): add(f'<b>{n}.</b> {text}')
def footer(c, doc):
    c.setStrokeColor(colors.HexColor('#C9D8DF'))
    c.line(42, 43, A4[0]-42, 43)
    c.setFont('Helvetica', 8)
    c.setFillColor(colors.HexColor('#526673'))
    c.drawString(42, 29, 'MicroGeog Mapper v0.42 | Quick user guide | 4 November 2026')
    c.drawRightString(A4[0]-42, 29, str(doc.page))

add('MicroGeog Mapper', 'GuideTitle')
add('A quick guide to turning photos and video into mapped features and 3D surveys.', 'GuideSub')
add('Use MicroGeog Mapper to record small features such as doors, entrances, bins and bicycle sheds. Upload images or video, inspect the results, add labels, and export data for use in GIS software.')
h('1  Open the app')
add('If your administrator has already started the service, open its web address. For the supplied Docker setup, run <b>docker compose up --build -d</b> in the project folder, then open <b>http://localhost:8000</b>. The first build and model downloads can take time.')
add('The supplied GPU setup needs an NVIDIA GPU, a compatible driver and NVIDIA Container Toolkit. Open <b>Settings</b> to choose the detector and depth options, adjust GPU memory settings, and enter a Meta API key if you intend to use Meta features.')
add('<b>Check the detector:</b> the supplied Docker configuration enables mock SAM detections. These are demonstration boxes, not real object recognition. Have the administrator select a real detector for operational use.', 'GuideSmall')
h('2  Choose a workflow')
rows = [[p('<b>Workflow</b>', 'GuideSmall'), p('<b>Use it for</b>', 'GuideSmall')]]
for name, text in [
    ('Single photo', 'Detect objects, estimate depth and create map pins from one image.'),
    ('Photo set to pins', 'Process a ZIP of photos and merge the resulting mapped features.'),
    ('Photo set to 3D', 'Reconstruct overlapping photos as a point cloud. Choose COLMAP, DA3 Small or DA3 Giant 1.1.'),
    ('Video survey', 'Build a cloud from video, match it to the map, then measure and tag locations.'),
    ('Photo + video to 3D', 'Use a ZIP containing one geotagged reference photo and a video to build a DA3 cloud.')
]: rows.append([p(name, 'GuideSmall'), p(text, 'GuideSmall')])
table=Table(rows, colWidths=[135, 376], hAlign='LEFT')
table.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#E7F0F4')),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),6),('LINEBELOW',(0,0),(-1,-1),0.4,colors.HexColor('#D5E0E5'))]))
story.append(table)
h('3  Prepare good input')
add('Use clear, sharp images with plenty of overlap for reconstruction. Move steadily when filming and avoid long blank sections. Keep EXIF GPS information when available. <b>Resize image ZIP</b> reduces photo sizes while retaining supported location metadata; <b>Region GeoJSON</b> downloads OpenStreetMap features for a chosen area.')

story.append(PageBreak())
add('Process, check and export', 'GuideTitle')
add('A practical sequence for your first survey.', 'GuideSub')
h('4  Upload and process')
step(1, 'Choose a workflow and upload its photo, photo ZIP or video. For Photo + video, the reference photo supplies the starting location and heading; capture it at the start of the video, looking the same way.')
step(2, 'Enter the objects you want to find, for example <b>door, steps, bin</b>. Select the detector and reconstruction options offered by the workflow, then start processing. Browser MobileNet uses its fixed object classes and ignores custom prompts.')
step(3, 'Review the image boxes, point cloud and map. GPS metadata can locate inputs. Spark location hints are candidate starting places: confirm them or choose a location manually. A suggested place does not register a 3D cloud to the map.')
h('5  Explore and register a video survey')
step(1, 'Use <b>Fit</b>, <b>Top</b> and the view controls to inspect the cloud. With the 3D canvas focused, use WASD to move, Q/E to turn, Z/C to roll, and R/F to move vertically. Home fits the view.')
step(2, 'Match at least <b>three non-collinear points</b> visible in both the cloud and the map. Spread them across the survey and choose recognisable, stable features.')
step(3, 'Select <b>Register cloud on map</b>. Inspect the reported RMS and individual residuals; correct poor control pairs and register again. Check the alignment visually before relying on measurements or geographic exports.')
add('Photo-set geographic alignment needs a reliable multi-photo GPS fit. An unregistered cloud has local coordinates; monocular depth can be an estimate, and measurements depend on a trustworthy scale.', 'GuideSmall')
h('6  Label features and ask Spark')
add('Use <b>TAG</b> to record a feature, its name and indoor/outdoor details; set the floor level for indoor items. Use <b>Identify</b> to inspect labels and saved answers. In <b>Process Classes</b>, enter the classes, questions and JSON answer templates. Preview the groups and request count before sending.')
add('Spark features send selected images and prompts to Meta and require a valid API key. Contributor requests may be used for training. Review the displayed request limits and returned answers.', 'GuideSmall')
h('7  Save and export')
add('Use <b>Save project</b> to retain the survey state for later work. After reopening, reselect the original video when frame previews require it. Use <b>GeoJSON</b> for mapped features or survey tags, <b>PLY / XYZ</b> for point clouds where offered, and the annotated-image export for single-photo results.')
add('Unregistered tags and answers can export with local coordinates and null map geometry. PLY retains reconstruction coordinates. If processing runs out of GPU memory, reduce the frame budget or resolution and try again.', 'GuideSmall')
add('Based on the project README and v0.42 interface. For software and model licensing, see LIBRARIES_AND_LICENCES.txt in the project folder.', 'GuideSmall')
doc=SimpleDocTemplate(str(out), pagesize=A4, rightMargin=42, leftMargin=42, topMargin=39, bottomMargin=59, title='MicroGeog Mapper - Quick User Guide', author='MicroGeog Mapper')
doc.build(story, onFirstPage=footer, onLaterPages=footer)
reader=PdfReader(out)
assert len(reader.pages)==2, f'Expected two pages, got {len(reader.pages)}'
assert all(len(page.extract_text())>500 for page in reader.pages)
print(f'Created and text-checked {len(reader.pages)} pages: {out}')
