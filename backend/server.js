const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = 8080;
const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  const types = {'.html':'text/html','.css':'text/css','.js':'application/javascript'};
  const contentType = types[ext] || 'text/plain';
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, {'Content-Type': contentType});
    res.end(content);
  });
});
server.listen(PORT, () => console.log(`RecepAI running on http://localhost:${PORT}`));
