const fs = require('fs');
const http = require('http');

const attackCode = fs.readFileSync('./contracts/attack.sol', 'utf8');
const postData = JSON.stringify({
  code: attackCode,
  replayMode: false
});

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/submit-attack',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
};

console.log('Submitting attack contract...');

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    try {
      const result = JSON.parse(data);
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.log('Raw response:', data);
    }
  });
});

req.on('error', (error) => {
  console.error('Error:', error.message);
});

req.write(postData);
req.end();
