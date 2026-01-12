const bulletCharacterMap: { [key: string]: string } = {
  "•": "&#8226;",
  "*": "&#8226;",
  "-": "&#8211;",
};

type RgbColor = { r: number; g: number; b: number };
type RgbaColor = { r: number; g: number; b: number; a: number };
type ImageExportMode = 'placeholder' | 'base64';

function figmaColorToHex(color: RgbColor): string {
  const toHex = (c: number) => ("0" + Math.round(c * 255).toString(16)).slice(-2);
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function findParentBackgroundColor(node: SceneNode): RgbColor {
  let parent = node.parent;
  while (parent && parent.type !== "PAGE") {
    if (
      "fills" in parent &&
      Array.isArray(parent.fills) &&
      parent.fills.length > 0
    ) {
      const solidFill = parent.fills.find(
        (f) => (f.type === "SOLID" || f.type.startsWith("GRADIENT")) && f.visible !== false
      ) as SolidPaint | GradientPaint;

      if (solidFill) {
        if (solidFill.type === 'SOLID') {
          if ((solidFill.opacity ?? 1) >= 0.99) {
            return solidFill.color;
          }
        } else {
          const firstStop = solidFill.gradientStops[0];
          if ((firstStop.color.a ?? 1) >= 0.99) {
            return { r: firstStop.color.r, g: firstStop.color.g, b: firstStop.color.b };
          }
        }
      }
    }
    parent = parent.parent;
  }
  return { r: 1, g: 1, b: 1 };
}

async function collectAndLoadAllFonts(nodes: readonly SceneNode[]) {
  const fontNames = new Set<FontName>();
  function findFonts(node: SceneNode) {
    if (node.type === 'TEXT' && node.fontName !== figma.mixed) {
      fontNames.add(node.fontName as FontName);
    }
    if ("children" in node) {
      for (const child of node.children) {
        findFonts(child);
      }
    }
  }
  for (const node of nodes) {
    findFonts(node);
  }
  if (fontNames.size > 0) {
    await Promise.all(Array.from(fontNames).map(font => figma.loadFontAsync(font)));
  }
}

class FigmaPluginParser {
  private useLiteralWidth = false;

  constructor(useLiteralWidth: boolean) {
    this.useLiteralWidth = useLiteralWidth;
  }

  private sanitizeStyles(styleStr: string): string {
    if (!styleStr) return "";
    const styleMap = new Map<string, string>();
    styleStr.split(";").filter((rule) => rule.trim()).forEach((rule) => {
      const [key, ...valueParts] = rule.split(":");
      const value = valueParts.join(":").trim();
      if (!key || !value) return;
      const prop = key.trim();
      styleMap.set(prop, value);
    });
    return Array.from(styleMap.entries()).map(([k, v]) => `${k}:${v}`).join(";");
  }

  private cleanZeroValueStyles(styleStr: string): string {
    if (!styleStr) return "";
    return styleStr.split(";").filter((rule) => {
      if (!rule.trim()) return false;
      const [key, value] = rule.split(":").map(s => s.trim());
      if (!value) return true;
      const isZero = /^0(px|pt|em|%|vw|vh)?$/.test(value);
      if (key.includes("border-radius") || (key.startsWith("padding") || key.startsWith("margin") || key.startsWith("border")) && isZero) {
        return false;
      }
      return true;
    }).join(";");
  }

  // --- FONT FALLBACK HELPER ---
  private getFontStack(family: string): string {
    const sansSerif = "Arial, Helvetica, sans-serif";
    const serif = "Georgia, 'Times New Roman', serif";
    const monospace = "'Courier New', Courier, monospace";

    const lower = family.toLowerCase();
    if (lower.includes('inter') || lower.includes('roboto') || lower.includes('helvetica') || lower.includes('arial')) return `'${family}', ${sansSerif}`;
    if (lower.includes('times') || lower.includes('georgia') || lower.includes('serif')) return `'${family}', ${serif}`;
    if (lower.includes('mono') || lower.includes('courier')) return `'${family}', ${monospace}`;

    // Default fallback
    return `'${family}', ${sansSerif}`;
  }

  private getSegmentStyleObject(style: any, parentBgColor: RgbColor): { [key: string]: string } {
    const styles: { [key: string]: string } = {};
    if (style.fills && style.fills.length > 0) {
      const { hex: colorHex } = this.getEffectiveBackgroundColorForFills(style.fills, parentBgColor);
      if (colorHex) styles['color'] = colorHex;
    }
    if (style.fontName?.family) {
      styles['font-family'] = this.getFontStack(style.fontName.family); // Use Fallback
      const f_style = style.fontName.style.toLowerCase();
      styles['font-weight'] = f_style.includes('bold') ? '700' : '400';
      styles['font-style'] = f_style.includes('italic') ? 'italic' : 'normal';
    }
    if (style.fontSize) styles['font-size'] = `${Math.round(style.fontSize)}px`;
    if (style.lineHeight?.unit !== 'AUTO') {
      if (style.lineHeight.unit === 'PIXELS') styles['line-height'] = `${Math.round(style.lineHeight.value)}px`;
      else if (style.lineHeight.unit === 'PERCENT') styles['line-height'] = `${Math.round(style.lineHeight.value)}%`;
    }
    styles['text-decoration'] = style.textDecoration === "UNDERLINE" ? 'underline' : 'none';
    return styles;
  }

  private styleObjectToCssString(styleObj: { [key: string]: string }): string {
    if (!styleObj || Object.keys(styleObj).length === 0) return "";
    const css = Object.keys(styleObj)
      .map(key => `${key}:${styleObj[key]}`)
      .join(';');
    return css ? `${css};` : '';
  }

  private diffStyleObjects(baseStyle: { [key: string]: string }, segmentStyle: { [key: string]: string }): { [key: string]: string } {
    const diff: { [key: string]: string } = {};
    for (const key in segmentStyle) {
      if (baseStyle[key] !== segmentStyle[key]) {
        diff[key] = segmentStyle[key];
      }
    }
    return diff;
  }

  private processTextNode(node: TextNode, parentBgColor: RgbColor): { baseStyle: { [key: string]: string }, innerHtml: string } {
    if (!node.characters?.trim()) {
      return { baseStyle: {}, innerHtml: "" };
    }
    const segments = node.getStyledTextSegments(['fontName', 'fontSize', 'fills', 'lineHeight', 'textDecoration']);
    if (segments.length === 0) {
      return { baseStyle: {}, innerHtml: "" };
    }

    // 1. Determine the "Base Style" for the parent TD.
    // Instead of naive "first segment wins", we pick the most common style (by character count)
    // to minimize the number of spans generated.
    const styleCounts = new Map<string, { count: number, style: { [key: string]: string } }>();
    let maxCount = -1;
    let mostCommonStyle: { [key: string]: string } = {};

    const processedSegments = segments.map(segment => {
      // Safety check for mixed props if any (though getStyledTextSegments splits them)
      if (typeof segment.fontName === 'symbol') return null;

      const style = this.getSegmentStyleObject(segment, parentBgColor);
      const styleKey = JSON.stringify(style); // Simple serialization for grouping

      const current = styleCounts.get(styleKey) || { count: 0, style };
      current.count += segment.characters.length;
      styleCounts.set(styleKey, current);

      if (current.count > maxCount) {
        maxCount = current.count;
        mostCommonStyle = style;
      }
      return { segment, style };
    });

    // Fallback: Use the first valid style if calculation failed (unlikely)
    if (Object.keys(mostCommonStyle).length === 0) {
      const firstValid = processedSegments.find(s => s !== null);
      if (firstValid) mostCommonStyle = firstValid.style;
    }

    const baseStyle = mostCommonStyle;
    let htmlOutput = "";

    for (const item of processedSegments) {
      if (!item) continue;
      const { segment, style: segmentStyle } = item;

      // 2. Diff against the Base Style
      const styleDiff = this.diffStyleObjects(baseStyle, segmentStyle);

      const sanitizedChars = segment.characters.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br />");
      const finalContent = bulletCharacterMap[sanitizedChars.trim()] || sanitizedChars;

      if (!finalContent) continue;

      if (Object.keys(styleDiff).length === 0) {
        htmlOutput += finalContent;
      } else {
        let tag = 'span';
        const diffKeys = Object.keys(styleDiff);
        // Optimization for simple tags
        if (diffKeys.length === 1 && diffKeys[0] === 'font-weight' && styleDiff['font-weight'] === '700') {
          tag = 'strong';
        } else if (diffKeys.length === 1 && diffKeys[0] === 'font-style' && styleDiff['font-style'] === 'italic') {
          tag = 'i';
        }

        const diffCss = this.styleObjectToCssString(styleDiff);
        htmlOutput += `<${tag} ${diffCss ? `style="${diffCss}"` : ''}>${finalContent}</${tag}>`;
      }
    }

    return { baseStyle, innerHtml: htmlOutput };
  }

  // --- FIM DOS MÉTODOS AUXILIARES ---

  private getBorderStyles(node: SceneNode): string | null {
    if (!("strokes" in node) || !Array.isArray(node.strokes) || node.strokes.length === 0 || !("strokeWeight" in node) || typeof node.strokeWeight !== 'number' || node.strokeWeight === 0) {
      return null;
    }
    const stroke = node.strokes.find((s) => s.visible !== false && s.type === "SOLID") as SolidPaint | undefined;
    if (!stroke || !stroke.color) return null;
    const weight = Math.round(node.strokeWeight);
    if (weight === 0) return null;
    const parentBg = findParentBackgroundColor(node);
    const { hex: colorHex } = this.getEffectiveBackgroundColorForFills([stroke], parentBg);
    return `border: ${weight}px solid ${colorHex || '#000000'};`;
  }

  private blendColors(fg: RgbaColor, bg: RgbColor): RgbColor {
    const r = fg.r * fg.a + bg.r * (1 - fg.a);
    const g = fg.g * fg.a + bg.g * (1 - fg.a);
    const b = fg.b * fg.a + bg.b * (1 - fg.a);
    return { r, g, b };
  }

  private getEffectiveBackgroundColorForFills(fills: readonly Paint[], parentBgColor: RgbColor): { hex: string | null; rgb: RgbColor } {
    if (!Array.isArray(fills) || fills.length === 0) return { hex: null, rgb: parentBgColor };
    const visibleFill = fills.find((f) => f.visible !== false);
    if (!visibleFill) return { hex: null, rgb: parentBgColor };

    let color: RgbColor;
    let opacity = 1.0;

    if (visibleFill.type === "SOLID") {
      color = visibleFill.color;
      opacity = visibleFill.opacity ?? 1;
    } else if (visibleFill.type.startsWith("GRADIENT")) {
      color = visibleFill.gradientStops[0].color;
      opacity = visibleFill.gradientStops[0].color.a ?? 1;
    } else {
      return { hex: null, rgb: parentBgColor };
    }

    if (opacity >= 0.99) return { hex: figmaColorToHex(color), rgb: color };
    const finalRgb = this.blendColors({ ...color, a: opacity }, parentBgColor);
    return { hex: figmaColorToHex(finalRgb), rgb: finalRgb };
  }

  private getEffectiveBackgroundColor(node: SceneNode, parentBgColor: RgbColor): { hex: string | null; rgb: RgbColor } {
    const fills = 'fills' in node ? node.fills : [];
    if (fills && fills !== figma.mixed) {
      return this.getEffectiveBackgroundColorForFills(fills as readonly Paint[], parentBgColor);
    }
    return { hex: null, rgb: parentBgColor };
  }

  private isImageLikeNode(node: SceneNode): boolean {
    if ((node.type === "RECTANGLE" || node.type === "ELLIPSE") && "fills" in node && Array.isArray(node.fills) && node.fills.some((f: any) => f.type === "IMAGE")) return true;
    if (["VECTOR", "LINE"].indexOf(node.type) !== -1) return true;
    if ("children" in node && node.children.length > 0) {
      return node.children.every(child => child.type !== "TEXT" && this.isImageLikeNode(child));
    }
    return false;
  }

  private async renderNode(node: SceneNode, parentWidth: number, parentBgColor: RgbColor, imageExportMode: ImageExportMode): Promise<string> {
    if (!node.visible) return "";
    // Clean Empty Nodes
    if ("opacity" in node && node.opacity === 0) return "";

    if (this.isImageLikeNode(node)) return this.renderImage(node, parentWidth, imageExportMode);

    switch (node.type) {
      case "FRAME":
      case "GROUP":
      case "COMPONENT":
      case "INSTANCE":
        if (isBulletPoint(node)) return this.renderBulletPoint(node, parentBgColor);
        return this.renderContainer(node, parentWidth, parentBgColor, false, imageExportMode);
      case "RECTANGLE":
      case "ELLIPSE":
        return this.renderShape(node, parentBgColor);
      case "TEXT":
        return this.renderText(node, parentBgColor);
      default:
        return "";
    }
  }

  private async getStackedRows(parentNode: FrameNode | GroupNode | ComponentNode | InstanceNode, parentWidth: number, parentBgColor: RgbColor, imageExportMode: ImageExportMode): Promise<string[]> {
    const children = ("children" in parentNode ? [...parentNode.children] : []).filter(c => c.visible);
    if ('layoutMode' in parentNode && parentNode.layoutMode !== 'VERTICAL') {
      children.sort((a, b) => a.y - b.y);
    }

    if (children.length === 0) return [];

    const paddingLeft = ('paddingLeft' in parentNode ? parentNode.paddingLeft : 0) as number;
    const paddingRight = ('paddingRight' in parentNode ? parentNode.paddingRight : 0) as number;
    const paddingTop = ('paddingTop' in parentNode ? parentNode.paddingTop : 0) as number;
    const availableWidth = parentWidth - paddingLeft - paddingRight;

    // --- Optimization: Unwrap Single Child ---
    if (children.length === 1) {
      const child = children[0];
      const verticalGap = Math.round(child.y - paddingTop);

      if (paddingLeft === 0 && paddingRight === 0 && verticalGap <= 2) {
        const childHtml = await this.renderNode(child, availableWidth, parentBgColor, imageExportMode);
        return childHtml ? [`<tr><td>${childHtml}</td></tr>`] : [];
      }
    }

    const colSpan = 1 + (paddingLeft > 0 ? 1 : 0) + (paddingRight > 0 ? 1 : 0);
    const rows: string[] = [];
    let lastBottomY = paddingTop;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const verticalGap = Math.round(child.y - lastBottomY);
      if (verticalGap > 2) {
        rows.push(`<tr><td height="${verticalGap}" style="height:${verticalGap}px; font-size:${verticalGap}px; line-height:${verticalGap}px;" colspan="${colSpan}">&nbsp;</td></tr>`);
      }

      const leftSpacer = paddingLeft > 0 ? `<td class="gutter" width="${paddingLeft}" style="width: ${paddingLeft}px;">&nbsp;</td>` : "";
      const rightSpacer = paddingRight > 0 ? `<td class="gutter" width="${paddingRight}" style="width: ${paddingRight}px;">&nbsp;</td>` : "";

      if (child.type === 'TEXT') {
        const textGroup: TextNode[] = [child];
        let j = i + 1;
        while (j < children.length && children[j].type === 'TEXT') {
          textGroup.push(children[j] as TextNode);
          j++;
        }

        const textRows: string[] = [];
        let lastTextNodeInGroupBottomY = child.y;

        for (const [index, textNode] of textGroup.entries()) {
          const gapWithinGroup = Math.round(textNode.y - lastTextNodeInGroupBottomY);
          if (index > 0 && gapWithinGroup > 2) {
            textRows.push(`<tr><td height="${gapWithinGroup}" style="height:${gapWithinGroup}px; font-size:${gapWithinGroup}px; line-height:${gapWithinGroup}px;">&nbsp;</td></tr>`);
          }
          // --- LÓGICA DE TEXTO ATUALIZADA ---
          const { baseStyle, innerHtml } = this.processTextNode(textNode, parentBgColor);
          if (innerHtml) {
            const textAlign = (textNode.textAlignHorizontal || 'LEFT').toLowerCase();
            const baseStyleCss = this.styleObjectToCssString(baseStyle);
            const borderCss = this.getBorderStyles(textNode) || "";
            let tdStyle = this.sanitizeStyles(this.cleanZeroValueStyles(`text-align:${textAlign};${baseStyleCss}${borderCss}`));
            if (tdStyle && !tdStyle.endsWith(';')) tdStyle += ';';
            textRows.push(`<tr><td align="${textAlign}" ${tdStyle ? `style="${tdStyle}"` : ''}>${innerHtml}</td></tr>`);
          }
          lastTextNodeInGroupBottomY = textNode.y + textNode.height;
        }

        if (paddingLeft === 0 && paddingRight === 0) {
          rows.push(...textRows);
        } else {
          const groupHtml = `<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">${textRows.join('')}</table>`;
          rows.push(`<tr>${leftSpacer}<td>${groupHtml}</td>${rightSpacer}</tr>`);
        }

        i = j - 1;
        lastBottomY = lastTextNodeInGroupBottomY;
      } else {
        const childHtml = await this.renderNode(child, availableWidth, parentBgColor, imageExportMode);
        if (childHtml) {
          rows.push(`<tr>${leftSpacer}<td>${childHtml}</td>${rightSpacer}</tr>`);
        }
        lastBottomY = child.y + child.height;
      }
    }
    return rows;
  }

  private async renderStackedChildren(parentNode: FrameNode | GroupNode | ComponentNode | InstanceNode, parentWidth: number, parentBgColor: RgbColor, imageExportMode: ImageExportMode): Promise<string> {
    const rows = await this.getStackedRows(parentNode, parentWidth, parentBgColor, imageExportMode);
    if (rows.length === 0) return "";
    return `<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">${rows.join('')}</table>`;
  }

  private async renderContainer(node: FrameNode | GroupNode | ComponentNode | InstanceNode, parentWidth: number, parentBgColor: RgbColor, isRoot: boolean, imageExportMode: ImageExportMode): Promise<string> {
    const { hex: bgColorHex, rgb: effectiveBgRgb } = this.getEffectiveBackgroundColor(node, parentBgColor);
    const children = "children" in node ? node.children.filter(c => c.visible) : [];
    if (children.length === 0 && !bgColorHex && !this.getBorderStyles(node)) return "";

    const layoutMode = 'layoutMode' in node ? node.layoutMode : 'NONE';
    const paddingTop = 'paddingTop' in node ? Math.round((node as any).paddingTop as number) : 0;
    const paddingBottom = 'paddingBottom' in node ? Math.round((node as any).paddingBottom as number) : 0;

    // Setup Container Styles
    let tableStyles = this.sanitizeStyles(this.cleanZeroValueStyles([bgColorHex ? `background-color:${bgColorHex}` : null, this.getBorderStyles(node)].filter(Boolean).join(";")));
    if (tableStyles) tableStyles += ';';

    const width = isRoot ? parentWidth : Math.min(node.width, parentWidth);
    let tableAttributes: string;

    // Logic for Width: Literal vs Default (100%)
    if (this.useLiteralWidth) {
      tableAttributes = `width="${width}" ${tableStyles ? `style="${tableStyles}"` : ''}`;
    } else {
      // Default to 100% if not using literal width
      tableAttributes = `width="100%" ${tableStyles ? `style="width: 100%; ${tableStyles}"` : (tableStyles ? `style="${tableStyles}"` : '')}`;
    }

    if (bgColorHex) tableAttributes += ` bgcolor="${bgColorHex}"`; // legacy attr backup

    // --- Optimization: Merge Wrapper and Content for Vertical Layout ---
    if (layoutMode !== "HORIZONTAL") { // Stacking
      // Check strict single child (unwrapping logic inside getStackedRows returns <tr><td>...</td></tr>, 
      // but if we want to return raw child without ANY table wrapper if container is invisible, we can check here)
      if (children.length === 1 && !bgColorHex && !this.getBorderStyles(node)) {
        const paddingLeft = ('paddingLeft' in node ? node.paddingLeft : 0) as number;
        const paddingRight = ('paddingRight' in node ? node.paddingRight : 0) as number;
        const childGap = children[0].y - paddingTop;
        // If simple wrapper, check if we can skip entire table structure
        if (paddingLeft === 0 && paddingRight === 0 && childGap <= 2 && paddingTop === 0 && paddingBottom === 0 && !isRoot) {
          return this.renderNode(children[0], parentWidth, parentBgColor, imageExportMode);
        }
      }

      const rows = await this.getStackedRows(node, parentWidth, effectiveBgRgb, imageExportMode);
      if (rows.length === 0 && !bgColorHex && !this.getBorderStyles(node)) return "";

      const paddingLeft = ('paddingLeft' in node ? node.paddingLeft : 0) as number;
      const paddingRight = ('paddingRight' in node ? node.paddingRight : 0) as number;
      const colSpan = 1 + (paddingLeft > 0 ? 1 : 0) + (paddingRight > 0 ? 1 : 0);

      // Add Padding Rows to the main set
      const paddingTopHtml = paddingTop > 0 ? `<tr><td height="${paddingTop}" style="font-size:${paddingTop}px; line-height:${paddingTop}px;" colspan="${colSpan}">&nbsp;</td></tr>` : "";
      const paddingBottomHtml = paddingBottom > 0 ? `<tr><td height="${paddingBottom}" style="font-size:${paddingBottom}px; line-height:${paddingBottom}px;" colspan="${colSpan}">&nbsp;</td></tr>` : "";

      return `<table ${tableAttributes} cellpadding="0" cellspacing="0" border="0" role="presentation">${paddingTopHtml}${rows.join('')}${paddingBottomHtml}</table>`;
    }

    // --- Horizontal Layout ---
    const frameNode = node as FrameNode;
    const horizontalChildren = (frameNode.children || []).filter((c) => c.visible !== false);
    const itemSpacing = typeof frameNode.itemSpacing === 'number' ? Math.round(frameNode.itemSpacing) : 0;
    const paddingLeft = ('paddingLeft' in frameNode ? frameNode.paddingLeft : 0) as number;
    const paddingRight = ('paddingRight' in frameNode ? frameNode.paddingRight : 0) as number;

    // Calculate colspan for padding rows: children + spacers + left/right padding cells
    const spacerCount = horizontalChildren.length > 1 ? horizontalChildren.length - 1 : 0;
    const colSpan = horizontalChildren.length + spacerCount + (paddingLeft > 0 ? 1 : 0) + (paddingRight > 0 ? 1 : 0);

    const cells: string[] = [];
    if (paddingLeft > 0) {
      cells.push(`<td width="${paddingLeft}" style="width: ${paddingLeft}px;">&nbsp;</td>`);
    }

    for (const [index, child] of horizontalChildren.entries()) {
      const childHtml = await this.renderNode(child, child.width, effectiveBgRgb, imageExportMode);
      let valign = "top";
      if (frameNode.counterAxisAlignItems === 'CENTER') valign = 'middle';
      if (frameNode.counterAxisAlignItems === 'MAX') valign = 'bottom';
      cells.push(`<td valign="${valign}">${childHtml}</td>`);

      if (index < horizontalChildren.length - 1 && itemSpacing > 0) {
        cells.push(`<td width="${itemSpacing}" style="width: ${itemSpacing}px;">&nbsp;</td>`);
      }
    }

    if (paddingRight > 0) {
      cells.push(`<td width="${paddingRight}" style="width: ${paddingRight}px;">&nbsp;</td>`);
    }

    const paddingTopHtml = paddingTop > 0 ? `<tr><td height="${paddingTop}" style="font-size:${paddingTop}px; line-height:${paddingTop}px;" colspan="${colSpan}">&nbsp;</td></tr>` : "";
    const paddingBottomHtml = paddingBottom > 0 ? `<tr><td height="${paddingBottom}" style="font-size:${paddingBottom}px; line-height:${paddingBottom}px;" colspan="${colSpan}">&nbsp;</td></tr>` : "";

    return `<table ${tableAttributes} cellpadding="0" cellspacing="0" border="0" role="presentation">${paddingTopHtml}<tr>${cells.join('')}</tr>${paddingBottomHtml}</table>`;
  }

  private async renderText(node: TextNode, parentBgColor: RgbColor): Promise<string> {
    if (!node.characters?.trim()) return "";

    const { baseStyle, innerHtml } = this.processTextNode(node, parentBgColor);
    if (!innerHtml) return "";

    const textAlign = (node.textAlignHorizontal || 'LEFT').toLowerCase();
    const baseStyleCss = this.styleObjectToCssString(baseStyle);
    const borderCss = this.getBorderStyles(node) || "";

    let tdStyle = this.sanitizeStyles(this.cleanZeroValueStyles(`text-align:${textAlign};${baseStyleCss}${borderCss}`));
    if (tdStyle && !tdStyle.endsWith(';')) tdStyle += ';';

    return `<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="${textAlign}" ${tdStyle ? `style="${tdStyle}"` : ''}>${innerHtml}</td></tr></table>`;
  }

  private async renderBulletPoint(node: FrameNode, parentBgColor: RgbColor): Promise<string> {
    const bulletNode = node.children[0] as TextNode;
    const textNode = node.children[1] as TextNode;
    const itemSpacing = typeof node.itemSpacing === 'number' ? node.itemSpacing : 8;

    const { baseStyle: bulletBaseStyle, innerHtml: bulletHtml } = this.processTextNode(bulletNode, parentBgColor);
    let bulletTdStyle = this.sanitizeStyles(`width:1%;${this.styleObjectToCssString(bulletBaseStyle)}`);
    if (bulletTdStyle && !bulletTdStyle.endsWith(';')) bulletTdStyle += ';';

    const { baseStyle: textBaseStyle, innerHtml: textHtml } = this.processTextNode(textNode, parentBgColor);
    let textTdStyle = this.sanitizeStyles(this.styleObjectToCssString(textBaseStyle));
    if (textTdStyle && !textTdStyle.endsWith(';')) textTdStyle += ';';

    return `<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation"><tr><td ${bulletTdStyle ? `style="${bulletTdStyle}"` : ''} valign="top">${bulletHtml}</td><td width="${itemSpacing}" style="width: ${itemSpacing}px;">&nbsp;</td><td ${textTdStyle ? `style="${textTdStyle}"` : ''} valign="top">${textHtml}</td></tr></table>`;
  }

  private renderShape(node: SceneNode, parentBgColor: RgbColor): string {
    const { width = 0, height = 0 } = node;
    if (width < 1 || height < 1) return "";
    const { hex: bgColorHex } = this.getEffectiveBackgroundColor(node, parentBgColor);
    const finalHeight = Math.round(height);
    let cellStyles = this.sanitizeStyles(this.cleanZeroValueStyles([bgColorHex ? `background-color:${bgColorHex}` : null, `height:${finalHeight}px;`, `font-size:1px;`, `line-height:1px;`, this.getBorderStyles(node)].filter(Boolean).join(";")));
    if (cellStyles && !cellStyles.endsWith(';')) cellStyles += ';';
    return `<table width="100%" height="${finalHeight}" cellpadding="0" cellspacing="0" border="0"><tr><td ${bgColorHex ? `bgcolor="${bgColorHex}"` : ''} ${cellStyles ? `style="${cellStyles}"` : ''}>&nbsp;</td></tr></table>`;
  }

  private async renderImage(node: SceneNode, parentWidth: number, mode: ImageExportMode): Promise<string> {
    const { width, height } = node;
    if (width < 1 || height < 1) return "";
    const finalWidth = Math.min(Math.round(width), parentWidth);
    const altText = node.name || 'Image';

    if (mode === 'placeholder') {
      const url = `https://placehold.co/${finalWidth}x${Math.round(height)}/EFEFEF/7F7F7F?text=${finalWidth}x${Math.round(height)}`;
      return `<img src="${url}" width="${finalWidth}" alt="${altText}" style="display: block; border: 0; width: 100%; max-width: ${finalWidth}px; height: auto;" />`;
    }

    try {
      const exportSettings: ExportSettingsImage = { format: 'PNG', constraint: { type: 'WIDTH', value: Math.round(width * 2) } };
      const imageBytes = await node.exportAsync(exportSettings);

      if (mode === 'base64') {
        const base64String = figma.base64Encode(imageBytes);
        return `<img src="data:image/png;base64,${base64String}" width="${finalWidth}" alt="${altText}" style="display: block; border: 0; width: 100%; max-width: ${finalWidth}px; height: auto;" />`;
      }
    } catch (e) {
      return `<p style="color:red;">Error exporting image: ${altText}</p>`;
    }
    return "";
  }

  public async parse(nodes: readonly SceneNode[], imageExportMode: ImageExportMode): Promise<string> {
    if (nodes.length === 0) return "";
    const rootBgColor = { r: 1, g: 1, b: 1 };

    if (nodes.length === 1) {
      const node = nodes[0];
      const isRootSelection = (node.parent?.type === 'PAGE');
      if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") {
        return this.renderContainer(node, node.width, rootBgColor, isRootSelection, imageExportMode);
      } else {
        return this.renderNode(node, node.width, rootBgColor, imageExportMode);
      }
    }

    const sortedNodes = [...nodes].sort((a, b) => a.y - b.y);
    const rows: string[] = [];
    let lastBottomY = sortedNodes[0].y;

    for (const [i, node] of sortedNodes.entries()) {
      if (i > 0) {
        const gap = Math.round(node.y - lastBottomY);
        if (gap > 2) rows.push(`<tr><td height="${gap}" style="height:${gap}px; font-size:${gap}px; line-height:${gap}px;">&nbsp;</td></tr>`);
      }

      const nodeHtml = await this.renderNode(node, node.width, rootBgColor, imageExportMode);

      if (nodeHtml.trim()) {
        rows.push(`<tr><td>${nodeHtml}</td></tr>`);
      }
      if (node.visible) {
        lastBottomY = node.y + node.height;
      }
    }

    return rows.join('');
  }
}

function isBulletPoint(node: SceneNode): node is FrameNode {
  if (node.type !== 'FRAME' || !node.visible || node.layoutMode !== 'HORIZONTAL' || !("children" in node) || node.children.length !== 2) return false;
  const [firstChild, secondChild] = node.children;
  if (firstChild.type !== 'TEXT' || secondChild.type !== 'TEXT') return false;
  const bulletChar = firstChild.characters.trim();
  return bulletChar.length === 1 && bulletChar in bulletCharacterMap;
}

figma.showUI(__html__, { width: 400, height: 480 });

async function processSelection(imageExportMode: ImageExportMode, useLiteralWidth: boolean) {
  const selectedNodes = figma.currentPage.selection;
  if (selectedNodes.length === 0) {
    figma.notify("Please select at least one element.");
    figma.ui.postMessage({ type: 'generated-html', payload: { html: '', assets: [] } });
    return;
  }

  await collectAndLoadAllFonts(selectedNodes);

  const parser = new FigmaPluginParser(useLiteralWidth);
  const html = await parser.parse(selectedNodes, imageExportMode);

  figma.ui.postMessage({
    type: 'generated-html',
    payload: {
      html,
      assets: [],
    }
  });
};

figma.ui.onmessage = async (msg: { type: string, payload: any }) => {
  if (msg.type === 'generate-html-for-selection') {
    await processSelection(msg.payload.imageExportMode, msg.payload.useLiteralWidth);
  }
};