declare module 'exceljs' {
  export class Workbook {
    constructor();
    creator: string;
    lastModifiedBy: string;
    created: Date;
    modified: Date;
    addWorksheet(name: string): Worksheet;
    xlsx: {
      writeBuffer(): Promise<Buffer>;
    };
  }
  export interface Worksheet {
    addRow(values: any[]): Row;
    mergeCells(range: string): void;
    columns: { key: string; width: number }[];
  }
  export interface Row {
    getCell(index: number): Cell;
  }
  export interface Cell {
    value: any;
    formula: string;
    style: CellStyle;
  }
  export interface CellStyle {
    font?: {
      bold?: boolean;
      size?: number;
      color?: { argb: string };
    };
    fill?: {
      type: string;
      pattern: string;
      fgColor?: { argb: string };
    };
    alignment?: {
      horizontal?: string;
      vertical?: string;
    };
    border?: {
      top?: { style: string };
      left?: { style: string };
      bottom?: { style: string };
      right?: { style: string };
    };
  }
}