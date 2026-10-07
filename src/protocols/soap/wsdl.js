'use strict';
// WSDL 1.1 for a SOAP service: document/literal wrapped, one SOAP 1.1 and one SOAP 1.2 binding/port
// on the same address. Generated per request so the address follows the resolved base URL.
const { entityXsd } = require('./model');
const { escapeXml, NS } = require('../../util/xml');

function opElements(op, ind) {
  const seq = (items) => items.map((p) => {
    if (p.list) {
      return `${ind}      <xsd:element name="${p.name}" minOccurs="0">`
        + `<xsd:complexType><xsd:sequence><xsd:element name="${p.list}" type="${p.type}" minOccurs="0" maxOccurs="unbounded"/></xsd:sequence></xsd:complexType>`
        + '</xsd:element>';
    }
    return `${ind}      <xsd:element name="${p.name}" type="${p.xsdType || p.type}" minOccurs="${p.required ? 1 : 0}"/>`;
  }).join('\n');
  const el = (name, items) => (items.length
    ? `${ind}<xsd:element name="${name}">\n${ind}  <xsd:complexType>\n${ind}    <xsd:sequence>\n${seq(items)}\n${ind}    </xsd:sequence>\n${ind}  </xsd:complexType>\n${ind}</xsd:element>`
    : `${ind}<xsd:element name="${name}"><xsd:complexType><xsd:sequence/></xsd:complexType></xsd:element>`);
  return `${el(op.name, op.input)}\n${el(`${op.name}Response`, op.output.map((o) => ({ ...o, required: !o.list })))}`;
}

function generateWsdl(svc, address) {
  const ind = '      ';
  const seen = new Set();
  const types = svc.entities.map((e) => entityXsd(e, seen, ind)).join('\n');
  const elements = svc.operations.map((op) => opElements(op, ind)).join('\n');

  const messages = svc.operations.map((op) => `  <wsdl:message name="${op.name}Request"><wsdl:part name="parameters" element="tns:${op.name}"/></wsdl:message>
  <wsdl:message name="${op.name}Response"><wsdl:part name="parameters" element="tns:${op.name}Response"/></wsdl:message>`).join('\n');

  const portOps = svc.operations.map((op) => `    <wsdl:operation name="${op.name}">
      <wsdl:documentation>${escapeXml(op.doc)}</wsdl:documentation>
      <wsdl:input message="tns:${op.name}Request"/>
      <wsdl:output message="tns:${op.name}Response"/>
      <wsdl:fault name="Fault" message="tns:Fault"/>
    </wsdl:operation>`).join('\n');

  const bindingOps = (p) => svc.operations.map((op) => `    <wsdl:operation name="${op.name}">
      <${p}:operation soapAction="${svc.action(op.name)}" style="document"/>
      <wsdl:input><${p}:body use="literal"/></wsdl:input>
      <wsdl:output><${p}:body use="literal"/></wsdl:output>
      <wsdl:fault name="Fault"><${p}:fault name="Fault" use="literal"/></wsdl:fault>
    </wsdl:operation>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions name="${svc.name}"
    targetNamespace="${svc.ns}"
    xmlns:tns="${svc.ns}"
    xmlns:f="${NS.faults}"
    xmlns:wsdl="${NS.wsdl}"
    xmlns:soap="${NS.wsdlSoap11}"
    xmlns:soap12="${NS.wsdlSoap12}"
    xmlns:xsd="${NS.xsd}">
  <wsdl:documentation>${escapeXml(`${svc.title} — mock SOAP service of the API Test Tool. Errors are SOAP faults with an f:faultDetail element (status, code, requestId, field errors).`)}</wsdl:documentation>
  <wsdl:types>
    <xsd:schema targetNamespace="${svc.ns}" elementFormDefault="qualified" xmlns:tns="${svc.ns}">
${types}
${elements}
    </xsd:schema>
    <xsd:schema targetNamespace="${NS.faults}" elementFormDefault="qualified">
      <xsd:element name="faultDetail">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="status" type="xsd:int"/>
            <xsd:element name="code" type="xsd:string" minOccurs="0"/>
            <xsd:element name="title" type="xsd:string"/>
            <xsd:element name="detail" type="xsd:string"/>
            <xsd:element name="requestId" type="xsd:string" minOccurs="0"/>
            <xsd:element name="timestamp" type="xsd:dateTime"/>
            <xsd:element name="errors" minOccurs="0">
              <xsd:complexType>
                <xsd:sequence>
                  <xsd:element name="error" minOccurs="0" maxOccurs="unbounded">
                    <xsd:complexType>
                      <xsd:simpleContent>
                        <xsd:extension base="xsd:string"><xsd:attribute name="field" type="xsd:string"/></xsd:extension>
                      </xsd:simpleContent>
                    </xsd:complexType>
                  </xsd:element>
                </xsd:sequence>
              </xsd:complexType>
            </xsd:element>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
    </xsd:schema>
  </wsdl:types>
${messages}
  <wsdl:message name="Fault"><wsdl:part name="fault" element="f:faultDetail"/></wsdl:message>
  <wsdl:portType name="${svc.name}PortType">
${portOps}
  </wsdl:portType>
  <wsdl:binding name="${svc.name}Soap11" type="tns:${svc.name}PortType">
    <soap:binding style="document" transport="${NS.http}"/>
${bindingOps('soap')}
  </wsdl:binding>
  <wsdl:binding name="${svc.name}Soap12" type="tns:${svc.name}PortType">
    <soap12:binding style="document" transport="${NS.http}"/>
${bindingOps('soap12')}
  </wsdl:binding>
  <wsdl:service name="${svc.name}">
    <wsdl:port name="${svc.name}Soap11Port" binding="tns:${svc.name}Soap11"><soap:address location="${escapeXml(address)}"/></wsdl:port>
    <wsdl:port name="${svc.name}Soap12Port" binding="tns:${svc.name}Soap12"><soap12:address location="${escapeXml(address)}"/></wsdl:port>
  </wsdl:service>
</wsdl:definitions>
`;
}

module.exports = { generateWsdl };
