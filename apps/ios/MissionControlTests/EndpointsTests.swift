//
//  EndpointsTests.swift
//  MissionControlTests
//

import XCTest
@testable import MissionControl

final class EndpointsTests: XCTestCase {

    func testBuildsPathsFromOrigin() {
        let endpoints = Endpoints(baseURLString: "https://foo.trycloudflare.com/")
        XCTAssertEqual(endpoints?.pair.absoluteString, "https://foo.trycloudflare.com/pair")
        XCTAssertEqual(endpoints?.command.absoluteString, "https://foo.trycloudflare.com/command")
        XCTAssertEqual(endpoints?.speech.absoluteString, "https://foo.trycloudflare.com/speech/transcribe")
        XCTAssertEqual(endpoints?.apns.absoluteString, "https://foo.trycloudflare.com/push/apns")
        XCTAssertEqual(endpoints?.webSocket?.absoluteString, "wss://foo.trycloudflare.com/ws")
    }

    func testDefaultsToHTTPSForBareHost() {
        XCTAssertEqual(Endpoints(baseURLString: "foo.com")?.pair.absoluteString, "https://foo.com/pair")
    }

    func testRejectsEmptyInput() {
        XCTAssertNil(Endpoints(baseURLString: "   "))
    }

    func testParsesPairingQRPayload() {
        let link = PairingLink(scanned: "https://foo.trycloudflare.com/#/pair?code=ABC123")
        XCTAssertEqual(link?.baseURLString, "https://foo.trycloudflare.com")
        XCTAssertEqual(link?.code, "ABC123")
    }

    func testParsesPairingCodeFromPlainQuery() {
        let link = PairingLink(scanned: "https://tunnel.example.com/pair?code=XYZ")
        XCTAssertEqual(link?.code, "XYZ")
    }

    func testNonURLScanIsNotAPairingLink() {
        XCTAssertNil(PairingLink(scanned: "just-a-code"))
    }
}
