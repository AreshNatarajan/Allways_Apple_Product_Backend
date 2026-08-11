 export const generateBarcode = (serialNumber) => {
    return `BC-${serialNumber?.trim().toUpperCase()}`;
};