import fs from 'fs';
import path from 'path';

const srcPath = 'D:\\turk\\COA_System_v36.html';
const destPath = 'D:\\turk\\mostanad\\Addvet_Template.html';

if (!fs.existsSync(srcPath)) {
    console.error('Source file not found:', srcPath);
    process.exit(1);
}

console.log('Reading COA_System_v36.html...');
const content = fs.readFileSync(srcPath, 'utf8');
const lines = content.split('\n');

function findFunctionRange(funcName) {
    let startIdx = -1;
    let endIdx = -1;
    let openBraces = 0;
    let started = false;
    for (let i = 0; i < lines.length; i++) {
        if (!started && lines[i].includes(funcName)) {
            startIdx = i;
            started = true;
        }
        if (started) {
            const line = lines[i];
            for (let c of line) {
                if (c === '{') openBraces++;
                if (c === '}') {
                    openBraces--;
                    if (openBraces === 0) {
                        endIdx = i;
                        return { start: startIdx + 1, end: endIdx + 1 };
                    }
                }
            }
        }
    }
    return { start: startIdx + 1, end: -1 };
}

console.log('Extracting template styles and functions...');
// 1. Get CSS part
const cssLine = lines.find(l => l.includes('.addvet-coa-root'));
const cssCode = cssLine ? cssLine.trim() : '.addvet-coa-root { font-family:"Geogrotesque Cyr","Geogrotesque Trial",Arial,Helvetica,sans-serif; }';

// 2. Get font-face block (around lines 26-28)
let fontFaceBlock = '';
const fontFaceStart = lines.findIndex(l => l.includes('@font-face { font-family:"Geogrotesque Cyr";'));
if (fontFaceStart !== -1) {
    fontFaceBlock = lines[fontFaceStart].trim();
}

// 3. Get addvetPdfToPxRect
const rangePdfToPx = findFunctionRange('function addvetPdfToPxRect');
const pdfToPxCode = rangePdfToPx.start > 0 && rangePdfToPx.end > 0 
    ? lines.slice(rangePdfToPx.start - 1, rangePdfToPx.end).join('\n')
    : '';

// 4. Get buildAddvetLockedOverlayHtml
const rangeOverlay = findFunctionRange('function buildAddvetLockedOverlayHtml');
const overlayCode = rangeOverlay.start > 0 && rangeOverlay.end > 0
    ? lines.slice(rangeOverlay.start - 1, rangeOverlay.end).join('\n')
    : '';

// 5. Get ADDVET_COA_MASTER_BG
let bgCode = '';
const bgIndex = lines.findIndex(l => l.includes('const ADDVET_COA_MASTER_BG'));
if (bgIndex !== -1) {
    bgCode = lines[bgIndex].trim();
}

// Build clean standalone HTML page
const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Addvet COA Standalone Template</title>
    <style>
        body {
            margin: 0;
            padding: 20px;
            background-color: #f3f4f6;
            display: flex;
            flex-direction: column;
            align-items: center;
            font-family: Arial, sans-serif;
        }
        .container {
            display: flex;
            flex-direction: column;
            gap: 20px;
            align-items: center;
        }
        .coa-preview-box {
            position: relative;
            width: 794px;
            height: 1123px;
            box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
            background-color: white;
            overflow: hidden;
        }
        .bg-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 1;
            pointer-events: none;
        }
        .overlay-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 2;
        }
        /* Embedded fonts and styles */
        ${fontFaceBlock}
        ${cssCode}
    </style>
</head>
<body>
    <div class="container">
        <h1>Addvet Certificate of Analysis (COA) Standalone Template</h1>
        <p>This is a complete rendered template combining the base64 background image, coordinates mapper, and HTML overlay stack.</p>
        
        <div class="coa-preview-box" id="coa-preview">
            <!-- Background Image -->
            <img class="bg-layer" id="coa-bg" alt="COA Background">
            
            <!-- Overlay Text Fields -->
            <div class="overlay-layer" id="coa-overlay"></div>
        </div>
    </div>

    <script>
        // Escape HTML helper
        function escapeHtml(string) {
            const matchHtmlRegExp = /["'&<>]/;
            const str = '' + string;
            const match = matchHtmlRegExp.exec(str);
            if (!match) return str;
            let escape;
            let html = '';
            let index = 0;
            let lastIndex = 0;
            for (index = match.index; index < str.length; index++) {
                switch (str.charCodeAt(index)) {
                    case 34: escape = '&quot;'; break;
                    case 38: escape = '&amp;'; break;
                    case 39: escape = '&#39;'; break;
                    case 60: escape = '&lt;'; break;
                    case 62: escape = '&gt;'; break;
                    default: continue;
                }
                if (lastIndex !== index) html += str.substring(lastIndex, index);
                lastIndex = index + 1;
                html += escape;
            }
            return lastIndex !== index ? html + str.substring(lastIndex, index) : html;
        }

        // Split constituents helper
        function splitConstituentsForLargeCount(ingredients) {
            const list = ingredients || [];
            if (list.length <= 6) {
                return { split: false, rowA: list, rowB: [] };
            }
            const mid = Math.ceil(list.length / 2);
            return {
                split: true,
                rowA: list.slice(0, mid),
                rowB: list.slice(mid)
            };
        }

        // Font size calculator helper
        function coaConstituentCellFontPx(count) {
            if (count <= 3) return 8.2;
            if (count <= 6) return 7.8;
            if (count <= 10) return 7.2;
            return 6.4;
        }

        // Background Image Data
        ${bgCode}

        // Coordinates translation
        ${pdfToPxCode}

        // Overlay Builder Function
        ${overlayCode}

        // Sample Data for Rendering
        const sampleData = {
            documentNo: "AV/COA/2026/001",
            issueDate: "21/06/2026",
            productName: "H-VIRAL",
            category: "Feed Additive",
            packing: "1L Bottle",
            batchSize: "5000 Litres",
            batchNo: "AVVHB1222002",
            prodDate: "02/2023",
            expDate: "02/2026",
            appearance: "Clear liquid",
            ph: "5.5 - 6.5",
            assay: "Conforms to specs",
            ingredients: [
                { name: "Herbal extracts (Olive Leaves)", amount: "400000", unit: "mg" },
                { name: "Dextrose", amount: "100000", unit: "mg" },
                { name: "Sorbitol", amount: "120000", unit: "mg" },
                { name: "Betaine", amount: "100000", unit: "mg" },
                { name: "Methionine", amount: "60000", unit: "mg" }
            ]
        };

        const sampleBrandInfo = {
            origin: "JORDAN",
            producer: "AFAQ ADDITIVES FEED CO.",
            certify: "This is to certify that the above mentioned product has been manufactured, analyzed and complies with the registered standards and quality specifications."
        };

        // Render the COA
        document.getElementById('coa-bg').src = ADDVET_COA_MASTER_BG;
        document.getElementById('coa-overlay').innerHTML = buildAddvetLockedOverlayHtml(sampleData, sampleBrandInfo);
    </script>
</body>
</html>
`;

fs.writeFileSync(destPath, htmlTemplate, 'utf8');
console.log('Successfully generated standalone HTML template at:', destPath);
