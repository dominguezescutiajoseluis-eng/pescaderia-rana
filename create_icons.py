import os
from PIL import Image, ImageDraw, ImageFont

os.makedirs('assets', exist_ok=True)

def create_icon(size, filename):
    img = Image.new('RGBA', (size, size), (13, 92, 117, 255)) # Ocean blue background #0d5c75
    draw = ImageDraw.Draw(img)
    
    # Draw a stylized fish / circle design
    margin = int(size * 0.1)
    draw.ellipse([margin, margin, size - margin, size - margin], outline=(56, 189, 248, 255), width=int(size*0.04))
    
    # Draw letter 'R' and fish symbol
    text = "R"
    try:
        font = ImageFont.truetype("arial.ttf", int(size * 0.45))
    except Exception:
        font = ImageFont.load_default()
    
    bbox = draw.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    draw.text(((size - w) / 2, (size - h) / 2 - int(size * 0.05)), text, fill=(255, 255, 255, 255), font=font)
    
    img.save(f'assets/{filename}')
    print(f"Icon created: assets/{filename}")

create_icon(192, 'icon-192.png')
create_icon(512, 'icon-512.png')
create_icon(180, 'apple-touch-icon.png')
