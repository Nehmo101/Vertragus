//
//  ContractsTests.swift
//  MissionControlTests
//

import XCTest
@testable import MissionControl

final class ContractsTests: XCTestCase {

    private func decode(_ json: String) throws -> IncomingMessage {
        try JSONDecoder().decode(IncomingMessage.self, from: Data(json.utf8))
    }

    func testDecodesSnapshotFrame() throws {
        let json = """
        {"type":"snapshot","at":123,"snapshot":{"profileId":"p1","workspaceSessionId":"s1",
        "goal":{"id":"g","title":"Ziel","active":true},
        "tasks":[{"id":"t1","title":"Task 1","role":"impl","status":"running","progress":42}],
        "budget":{"tokens":1000,"costUsd":0.5,"caps":{"maxTokens":5000},"exceeded":false}}}
        """
        guard case let .snapshot(snapshot) = try decode(json) else { return XCTFail("expected snapshot") }
        XCTAssertEqual(snapshot.sessionKey, "s1")
        XCTAssertEqual(snapshot.goal?.title, "Ziel")
        XCTAssertEqual(snapshot.tasks.first?.status, .running)
        XCTAssertEqual(snapshot.tasks.first?.progress, 42)
        XCTAssertEqual(snapshot.budget?.tokens, 1000)
    }

    func testDecodesApprovalsFrame() throws {
        let json = """
        {"type":"approvals","at":1,"approvals":[{"id":"a1","kind":"plan-review",
        "profileId":"p1","workspaceSessionId":"s1","title":"Plan","summary":"2 Aufgaben",
        "createdAt":5,"actions":["plan.approve","plan.reject"]}]}
        """
        guard case let .approvals(items) = try decode(json) else { return XCTFail("expected approvals") }
        XCTAssertEqual(items.first?.kind, .planReview)
        XCTAssertEqual(items.first?.actions, ["plan.approve", "plan.reject"])
    }

    func testDecodesCommandResult() throws {
        let json = #"{"type":"command-result","requestId":"r1","ok":true,"result":{"diff":"--- a/x"}}"#
        guard case let .commandResult(requestId, ok, result, _) = try decode(json) else {
            return XCTFail("expected command-result")
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertTrue(ok)
        XCTAssertEqual(result?.diff, "--- a/x")
    }

    func testUnknownStatusDecodesToUnknown() throws {
        let json = #"{"type":"snapshot","at":1,"snapshot":{"tasks":[{"id":"t","title":"X","status":"brand-new"}]}}"#
        guard case let .snapshot(snapshot) = try decode(json) else { return XCTFail("expected snapshot") }
        XCTAssertEqual(snapshot.tasks.first?.status, .unknown)
    }

    func testEncodesCommandEnvelope() throws {
        let envelope = CommandEnvelope(
            id: RemoteCommandId.planApprove.rawValue,
            args: ScopeArgs(profileId: "p1", sessionId: "s1"),
            requestId: "r1"
        )
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(envelope)) as? [String: Any]
        XCTAssertEqual(object?["id"] as? String, "plan.approve")
        XCTAssertEqual((object?["args"] as? [String: Any])?["profileId"] as? String, "p1")
        XCTAssertEqual(object?["requestId"] as? String, "r1")
    }

    func testOptionalCommandArgsAreOmittedWhenNil() throws {
        let envelope = CommandEnvelope(
            id: RemoteCommandId.budgetSetCaps.rawValue,
            args: BudgetArgs(profileId: "p", sessionId: "s", maxTokens: 1000, maxCostUsd: nil),
            requestId: nil
        )
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(envelope)) as? [String: Any]
        let args = object?["args"] as? [String: Any]
        XCTAssertNotNil(args?["maxTokens"])
        XCTAssertNil(args?["maxCostUsd"], "encodeIfPresent must omit nil optionals")
        XCTAssertNil(object?["requestId"], "nil requestId must be omitted")
    }
}
