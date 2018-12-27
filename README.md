# Baiji swagger plugin

### Installation

```bash
npm install baiji-swagger --save
```

### Usage

```javascript
const baiji = require('baiji');

const app = baiji('myApp');

app.plugin(
  require('baiji-swagger'),
  {
    basicAuth: { name: 'doc', pass: 'your_doc_password' },
    swagger: {
      info: { title: 'My API DOCUMENTATION' }
    }
  }
);

app.listen(3000);
```

Then browse your api documentation at `http://localhost:3000/__swagger__/`

Enjoy!
