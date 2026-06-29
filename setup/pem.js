
function pemToDer(pem) {
    const b64 = pem
	  .replace(/-----BEGIN [^-]+-----/, "")
	  .replace(/-----END [^-]+-----/, "")
	  .replace(/\s+/g, "");
    const bin = atob(b64);
    const der = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
	der[i] = bin.charCodeAt(i);
    return der;
}

function derLen(n) {
    if (n < 0x80)
	return [n];
    const out = [];
    let v = n;
    while (v > 0) {
	out.unshift(v & 0xff); v = Math.floor(v / 256);
    }
    return [0x80 | out.length, ...out];
}
export function pkcs1ToPkcs8Pem(pkcs1Pem) {
    if (/BEGIN PRIVATE KEY/.test(pkcs1Pem))
	return pkcs1Pem.trim() + "\n"; // already PKCS#8
    const pkcs1 = pemToDer(pkcs1Pem);
    const algId = [0x30,0x0d,0x06,0x09,0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x01,0x01,0x05,0x00];
    const octet = [0x04, ...derLen(pkcs1.length), ...pkcs1];
    const body = [0x02,0x01,0x00, ...algId, ...octet];
    const der = new Uint8Array([0x30, ...derLen(body.length), ...body]);
    let bin = "";
    for (const b of der)
	bin += String.fromCharCode(b);
    const b64 = btoa(bin).match(/.{1,64}/g).join("\n");
    return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}
