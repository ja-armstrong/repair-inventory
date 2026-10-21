import type { LabelSize } from "../components/LabelSheet";

/**
 * DYMO Connect .label XML generator (ticket 19).
 *
 * The barcode and human-readable serial are rendered as SEPARATE objects.
 * This avoids relying on DYMO's TextPosition=Bottom behavior, which can
 * cause the serial text to overlap the barcode bars.
 */

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const BRUSHES = `          <Brushes>
            <BackgroundBrush>
              <SolidColorBrush>
                <Color A="0" R="1" G="1" B="1">
                </Color>
              </SolidColorBrush>
            </BackgroundBrush>
            <BorderBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0">
                </Color>
              </SolidColorBrush>
            </BorderBrush>
            <StrokeBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0">
                </Color>
              </SolidColorBrush>
            </StrokeBrush>
            <FillBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0">
                </Color>
              </SolidColorBrush>
            </FillBrush>
          </Brushes>`;

function textObject(
  name: string,
  text: string,
  fontSize: number,
  bold: boolean,
  x: number,
  y: number,
  w: number,
  h: number
): string {
  return `        <TextObject>
          <Name>${xmlEscape(name)}</Name>
${BRUSHES}
          <Rotation>Rotation0</Rotation>
          <OutlineThickness>1</OutlineThickness>
          <IsOutlined>False</IsOutlined>
          <Margin>
            <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
          </Margin>
          <HorizontalAlignment>Center</HorizontalAlignment>
          <VerticalAlignment>Middle</VerticalAlignment>
          <FitMode>AlwaysFit</FitMode>
          <IsVertical>False</IsVertical>
          <FormattedText>
            <FitMode>AlwaysFit</FitMode>
            <HorizontalAlignment>Center</HorizontalAlignment>
            <VerticalAlignment>Middle</VerticalAlignment>
            <IsVertical>False</IsVertical>
            <LineTextSpan>
              <TextSpan>
                <Text>${xmlEscape(text)}</Text>
                <FontInfo>
                  <FontName>Arial</FontName>
                  <FontSize>${fontSize}</FontSize>
                  <IsBold>${bold ? "True" : "False"}</IsBold>
                  <IsItalic>False</IsItalic>
                  <IsUnderline>False</IsUnderline>
                  <FontBrush>
                    <SolidColorBrush>
                      <Color A="1" R="0" G="0" B="0">
                      </Color>
                    </SolidColorBrush>
                  </FontBrush>
                </FontInfo>
              </TextSpan>
            </LineTextSpan>
          </FormattedText>
          <ObjectLayout>
            <DYMOPoint>
              <X>${x.toFixed(4)}</X>
              <Y>${y.toFixed(4)}</Y>
            </DYMOPoint>
            <Size>
              <Width>${w.toFixed(4)}</Width>
              <Height>${h.toFixed(4)}</Height>
            </Size>
          </ObjectLayout>
        </TextObject>`;
}

/**
 * One serial label in the DYMO Connect format.
 *
 * Layout:
 *
 *   SKU NAME
 *
 *   ████████████████████
 *   ████████████████████
 *   ████████████████████
 *       SERIAL NUMBER
 *
 * The barcode's human-readable text is disabled. The serial number is
 * rendered separately so it cannot overlap the barcode.
 */
export function buildSerialLabelXml(
  size: LabelSize,
  entry: { serial: string; skuName: string }
): string {
  // Landscape: the long stock dimension runs horizontally.
  const longIn = Math.max(size.widthIn, size.heightIn);
  const shortIn = Math.min(size.widthIn, size.heightIn);

  // Printable area.
  const rectW = Math.max(0.5, longIn - 0.29);
  const rectH = Math.max(0.3, shortIn - 0.128);

  /*
   * Overall horizontal sizing.
   */
  const objW = rectW - 0.1;
  const objX = 0.145 + 0.05;

  /*
   * SKU name.
   */
  const nameH = Math.min(0.5, rectH * 0.22);
  const nameY = 0.064 + 0.03;

  /*
   * Barcode.
   *
   * This is deliberately separate from the serial text.
   */
  const gap = Math.min(0.08, rectH * 0.04);
  const barcodeY = nameY + nameH + gap;

  /*
   * Reserve explicit space for the barcode itself.
   */
  const barcodeH = Math.min(
    0.45,
    Math.max(0.3, rectH * 0.45)
  );

  /*
   * Serial number goes underneath the barcode.
   */
  const serialGap = 0.02;
  const serialY = barcodeY + barcodeH + serialGap;

  /*
   * Human-readable serial height.
   */
  const serialH = Math.min(
    0.2,
    Math.max(0.14, rectH * 0.12)
  );

  return `<?xml version="1.0" encoding="utf-8"?>
<LabelFile version="1">
  <LabelApplication>Blank</LabelApplication>
  <DYMOLabel>
    <Description>DYMO Label</Description>
    <Orientation>Landscape</Orientation>
    <LabelName>Shipping</LabelName>
    <InitialLength>0</InitialLength>
    <BorderStyle>SolidLine</BorderStyle>

    <DYMORect>
      <DYMOPoint>
        <X>0.145</X>
        <Y>0.064</Y>
      </DYMOPoint>
      <Size>
        <Width>${rectW.toFixed(4)}</Width>
        <Height>${rectH.toFixed(4)}</Height>
      </Size>
    </DYMORect>

    <BorderColor>
      <SolidColorBrush>
        <Color A="1" R="0" G="0" B="0">
        </Color>
      </SolidColorBrush>
    </BorderColor>

    <BorderThickness>1</BorderThickness>
    <Show_Border>False</Show_Border>

    <DynamicLayoutManager>
      <RotationBehavior>ClearObjects</RotationBehavior>

      <LabelObjects>

${textObject(
  "SKUName",
  entry.skuName,
  16,
  true,
  objX,
  nameY,
  objW,
  nameH
)}

        <BarcodeObject>
          <Name>SerialBarcode</Name>
${BRUSHES}
          <Rotation>Rotation0</Rotation>
          <OutlineThickness>1</OutlineThickness>
          <IsOutlined>False</IsOutlined>

          <Margin>
            <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
          </Margin>

          <BarcodeFormat>Code128Auto</BarcodeFormat>
          <Data>${xmlEscape(entry.serial)}</Data>

          <HorizontalAlignment>Center</HorizontalAlignment>
          <VerticalAlignment>Middle</VerticalAlignment>

          <Size>Small</Size>
          <TextPosition>None</TextPosition>

          <FontInfo>
            <FontName>Arial</FontName>
            <FontSize>14</FontSize>
            <IsBold>False</IsBold>
            <IsItalic>False</IsItalic>
            <IsUnderline>False</IsUnderline>
            <FontBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0">
                </Color>
              </SolidColorBrush>
            </FontBrush>
          </FontInfo>

          <ObjectLayout>
            <DYMOPoint>
              <X>${objX.toFixed(4)}</X>
              <Y>${barcodeY.toFixed(4)}</Y>
            </DYMOPoint>
            <Size>
              <Width>${objW.toFixed(4)}</Width>
              <Height>${barcodeH.toFixed(4)}</Height>
            </Size>
          </ObjectLayout>
        </BarcodeObject>

${textObject(
  "SerialText",
  entry.serial,
  12,
  false,
  objX,
  serialY,
  objW,
  serialH
)}

      </LabelObjects>
    </DynamicLayoutManager>
  </DYMOLabel>
</LabelFile>`;
}

export const LABEL_WRITER_PRINT_PARAMS_XML =
  "<LabelWriterPrintParams><Copies>1</Copies></LabelWriterPrintParams>";