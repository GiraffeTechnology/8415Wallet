/** Wrap text to a column width, for the text renderers. */
export function wrapText(text, width) {
    const words = text.split(/\s+/).filter((word) => word.length > 0);
    const lines = [];
    let current = '';
    for (const word of words) {
        if (current.length === 0)
            current = word;
        else if (current.length + 1 + word.length <= width)
            current += ` ${word}`;
        else {
            lines.push(current);
            current = word;
        }
    }
    if (current.length > 0)
        lines.push(current);
    return lines;
}
