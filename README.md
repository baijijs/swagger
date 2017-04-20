# Baiji swagger plugin


### Installation

```bash
npm install baiji-swagger
```

### Usage

```javascript
const baiji = require('baiji');

const app = baiji('myApp');

app.plugin(
  require('baiji-swagger'),
  {
    swagger: {
      info: { title: 'My API DOCUMENTATION' }
    }
  }
);

app.listen(3000);
```

Then browse your api documentation at `http://localhost:3000/__swagger__/`

Enjoy!
