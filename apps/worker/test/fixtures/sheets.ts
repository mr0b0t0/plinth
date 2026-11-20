// The sheet the sheet tests publish: a small budget with currency columns and formulas.
export const HEADER =
  '{"plinth":"sheet","v":1,"columns":[{"name":"Item","type":"text","width":200},{"name":"Qty","type":"number"},{"name":"Unit price","type":"number","format":{"style":"currency","currency":"EUR","decimals":2}},{"name":"Total","type":"number","format":{"style":"currency","currency":"EUR","decimals":2}},{"name":"Paid","type":"checkbox"}],"freeze":{"cols":1}}';
export const SHEET = [
  HEADER,
  '["Apples",3,1.2,"=B2*C2",true]',
  '["Pears",5,0.8,"=B3*C3",false]',
  '["Total",null,null,"=SUM(D2:D3)"]',
].join("\n");
