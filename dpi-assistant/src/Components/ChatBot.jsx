import React, {
  useState,
  forwardRef,
  useImperativeHandle,
  useEffect,
  useRef,
} from "react";
import { sendChatMessage, sendFeedback } from "../services/api";
import { ThumbsUp, ThumbsDown } from "lucide-react";
import Animated_Logo2 from "./Animated_Logo2";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/* ---------------------------------------------------
   DISCLAIMER COMPONENT (Reusable)
--------------------------------------------------- */
const Disclaimer = () => (
  <div className="bg-[#FFF7D6] border border-[#F3E7A4] text-[#5B4E1E] rounded-xl px-4 py-3 text-sm flex gap-2 items-start shadow-sm w-full max-w-[800px] mx-auto mb-[20px]">
    <img
      src="https://cdn-icons-png.flaticon.com/512/471/471713.png"
      alt="info"
      className="w-5 h-5 mt-[2px] opacity-70"
    />
    <p className="leading-snug text-[13px] md:text-[14px]">
      <span className="font-semibold">NOTE:</span> “I'm learning with every
      prompt. If I ever say something that feels off, unbelievable, or just weird,
      please reach my creators at{" "}
      <a
        href="mailto:info@cdpi.dev"
        className="underline font-medium text-[#5B4E1E]"
      >
        info@cdpi.dev
      </a>
      .”
    </p>
  </div>
);

const ChatBot = forwardRef((_, ref) => {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [persona] = useState("Default");

  // New: ref for the scrollable messages container (we'll scroll this element only)
  const messagesContainerRef = useRef(null);

  // keep as sentinel if you still need it (not used to scroll the page)
  const messagesEndRef = useRef(null);

  // Auto-scroll the messages container to bottom when messages change.
  // This uses scrollTop = scrollHeight so the *page* won't jump.
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (el) {
      // allow a micro-delay for layout to settle (optional)
      // but avoid using element.scrollIntoView which can trigger page scrolling
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isLoading]);

  useImperativeHandle(ref, () => ({
    handleExternalQuestion(question) {
      handleSendMessage(question);
    },
  }));

  const handleSendMessage = async (messageText) => {
    const textToSend = messageText || input;
    if (!textToSend.trim()) return;

    // Create user message
    const userMessage = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      sender: "user",
      text: textToSend,
      timestamp: Date.now(),
    };

    // Add user message and clear input
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      // Prepare chat history for API
      const chatHistoryForApi = messages.map((m) => ({
        sender: m.sender,
        text: m.text || m.answer || "",
      }));

      // Call the API
      const response = await sendChatMessage(textToSend, chatHistoryForApi, persona);

      // Create assistant message from response
      const assistantMessage = {
        id: response.id,
        sender: "assistant",
        answer: response.answer,
        sources: response.sources,
        suggestedDPIs: response.suggestedDPIs,
        reasoning: response.reasoning,
        error: response.error,
        timestamp: response.timestamp,
        feedback: null,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      // Create error message
      const errorMessage = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        sender: "assistant",
        error: `Failed to get response: ${error.message}. Make sure the backend server is running.`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFeedback = async (messageId, feedbackType) => {
    // Update local state immediately
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId ? { ...m, feedback: feedbackType } : m
      )
    );

    try {
      await sendFeedback(messageId, feedbackType);
    } catch (error) {
      console.error("Failed to submit feedback:", error);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  /* ----------------- AI Thinking Loading ------------------ */
  const AICognition = () => {
    const thinkingPhrases = [
      "Analyzing your query...",
      "Scanning DPI knowledge base...",
      "Connecting insights across domains...",
      "Formulating an intelligent response...",
    ];
    const [currentPhrase, setCurrentPhrase] = useState(0);

    useEffect(() => {
      const interval = setInterval(() => {
        setCurrentPhrase((prev) => (prev + 1) % thinkingPhrases.length);
      }, 1600);
      return () => clearInterval(interval);
    }, []);

    return (
      <div className="flex flex-col gap-3 items-start w-full relative">
        <div className="relative flex items-center justify-center">
          <div className="absolute w-10 h-10 rounded-full blur-md animate-pulse"></div>
          <img
            src="https://cdpi-media.s3.amazonaws.com/logo_svg.svg"
            alt=""
            className="w-8 h-8 relative z-10"
          />
        </div>

        <div className="relative w-[160px] h-[6px] overflow-hidden rounded-full bg-purple-100">
          <div className="absolute inset-0 bg-gradient-to-r from-fuchsia-50 to-purple-100 animate-[wave_2s_linear_infinite]" />
        </div>

        <p className="text-xs text-gray-600 italic mt-1 animate-fadeIn">
          {thinkingPhrases[currentPhrase]}
        </p>

        <style jsx>{`
          @keyframes wave {
            0% {
              transform: translateX(-100%);
            }
            100% {
              transform: translateX(100%);
            }
          }
        `}</style>
      </div>
    );
  };

  // INITIAL UI (no messages yet)
  if (messages.length === 0) {
    return (
      <div className="lg:max-w-[1212px] font-outfit mx-auto flex flex-col items-center bg-gradient-to-r from-fuchsia-50 to-purple-100 px-6 pb-10 pt-4">
        {/* ⭐ DISCLAIMER on Landing */}
        <Disclaimer />

        <div className="bg-white w-[101px] h-[101px] md:w-[214px] md:h-[214px] lg:w-[164px] lg:h-[164px] mx-auto mt-[20px] rounded-full flex-shrink-0">
          <Animated_Logo2
            src="logo_svg.svg"
            className="mx-auto w-[71px] h-[71px] mt-[15px] md:w-[150px] md:h-[150px] lg:w-[100px] lg:h-[100px] md:mt-[29px]"
            alt=""
          />
        </div>

        <div className="mx-auto text-[24px] md:text-[64px] lg:text-[50px] font-semibold text-center mt-4">
          Ask your <span className="text-purple-600">DPI AI Assistant</span>
        </div>

        <p className="text-[16px] text-center md:text-[25px] lg:text-[22px] max-w-4xl mt-2">
          An interactive tool for you to better understand and implement DPI in your nations.
          <br />
          Ask in English, French, Spanish, Portuguese, or other languages!
        </p>
            
        <div className="flex gap-[20px] md:mt-[20px] mt-[60px]">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-[213px]  h-[56px] md:w-[526px] md:h-[47px] rounded-[10px] lg:w-[850px] md:text-[20px] border-black text-[13px] p-2 resize-none placeholder:text-gray-500"
            placeholder="Type your question here or start with a prompt below..."
          />
          <button
            onClick={() => handleSendMessage()}
            className="w-[45px] h-[45px] bg-purple-500 rounded-full md:mb-[25px] hover:bg-purple-700 hover:scale-110 transition-transform"
            type="button"
          >
            <img
              className="w-[25px] h-[25px] mx-auto relative left-[2px]"
              src="https://cdpi-media.s3.amazonaws.com/Sent.png"
              alt="Send"
            />
          </button>
        </div>
      </div>
    );
  }

  /* ----------------- CHAT MODE ------------------ */
  return (
    <div className="font-outfit bg-gradient-to-r from-fuchsia-50 to-purple-100 px-6 py-6 lg:max-w-[1212px] mx-auto rounded-2xl">
      <div className="bg-white rounded-2xl shadow-sm flex flex-col min-h-[500px] max-h-[700px]">
        {/* Messages Area */}
        <div
          ref={messagesContainerRef}
          // Important: overflow-anchor: none prevents browser auto-jump when content changes
          style={{ overflowAnchor: "none" }}
          className="flex-1 overflow-y-auto p-6 space-y-4"
        >
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.sender === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] ${
                  message.sender === "user"
                    ? "bg-purple-50 border border-purple-200 rounded-2xl px-4 py-2"
                    : "flex flex-col gap-2"
                }`}
              >
                {message.sender === "user" ? (
                  <p className="text-sm text-gray-800">{message.text}</p>
                ) : (
                  <>
                    <div className="flex items-start gap-3">
                      <img
                        src="https://cdpi-media.s3.amazonaws.com/logo_svg.svg"
                        alt="DPI Assistant"
                        className="w-8 h-8 flex-shrink-0"
                      />
                      <div className="flex-1">
                        {message.error ? (
                          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
                            {message.error}
                          </div>
                        ) : message.answer ? (
                          <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
                            <div className="prose prose-sm max-w-none text-gray-700">
                              <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                components={{
                                  h1: ({node, ...props}) => <h1 className="text-xl font-bold mt-4 mb-2 text-gray-900" {...props} />,
                                  h2: ({node, ...props}) => <h2 className="text-lg font-bold mt-3 mb-2 text-gray-900" {...props} />,
                                  h3: ({node, ...props}) => <h3 className="text-base font-semibold mt-2 mb-1 text-gray-900" {...props} />,
                                  p: ({node, ...props}) => <p className="mb-2 leading-relaxed" {...props} />,
                                  ul: ({node, ...props}) => <ul className="list-disc pl-5 mb-2 space-y-1" {...props} />,
                                  ol: ({node, ...props}) => <ol className="list-decimal pl-5 mb-2 space-y-1" {...props} />,
                                  li: ({node, ...props}) => <li className="leading-relaxed" {...props} />,
                                  strong: ({node, ...props}) => <strong className="font-semibold text-gray-900" {...props} />,
                                  em: ({node, ...props}) => <em className="italic" {...props} />,
                                  code: ({node, inline, ...props}) =>
                                    inline ? (
                                      <code className="bg-gray-200 px-1 py-0.5 rounded text-xs font-mono" {...props} />
                                    ) : (
                                      <code className="block bg-gray-800 text-gray-100 p-2 rounded text-xs font-mono overflow-x-auto" {...props} />
                                    ),
                                  a: ({node, ...props}) => <a className="text-purple-600 hover:text-purple-800 underline" {...props} />,
                                }}
                              >
                                {message.answer}
                              </ReactMarkdown>
                            </div>
                            {/* Sources hidden as requested */}
                          </div>
                        ) : message.suggestedDPIs ? (
                          <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
                            <p className="text-sm text-gray-700 mb-3">
                              {message.reasoning}
                            </p>
                            <div className="space-y-2">
                              {message.suggestedDPIs.map((dpi, idx) => (
                                <div
                                  key={idx}
                                  className="bg-white border border-purple-100 rounded-lg p-3"
                                >
                                  <h4 className="font-semibold text-purple-700 text-sm mb-1">
                                    {dpi.name}
                                  </h4>
                                  <p className="text-xs text-gray-600">
                                    {dpi.relevance}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        {/* Feedback buttons */}
                        {!message.error && (
                          <div className="flex gap-2 mt-2">
                            <button
                              onClick={() => handleFeedback(message.id, "up")}
                              className={`p-1 rounded hover:bg-gray-100 transition ${
                                message.feedback === "up" ? "text-green-600" : "text-gray-400"
                              }`}
                            >
                              <ThumbsUp className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleFeedback(message.id, "down")}
                              className={`p-1 rounded hover:bg-gray-100 transition ${
                                message.feedback === "down" ? "text-red-600" : "text-gray-400"
                              }`}
                            >
                              <ThumbsDown className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}

          {/* Loading indicator */}
          {isLoading && (
            <div className="flex justify-start">
              <div className="flex items-start gap-3">
                <img
                  src="https://cdpi-media.s3.amazonaws.com/logo_svg.svg"
                  alt="DPI Assistant"
                  className="w-8 h-8"
                />
                <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
                  <AICognition />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="border-t border-gray-200 p-4">
          <div className="flex gap-3 items-end">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 min-h-[45px] max-h-[120px] rounded-lg text-sm p-3 resize-none border border-gray-300 focus:outline-none focus:ring-2 focus:ring-purple-500 placeholder:text-gray-400"
              placeholder="Type your question..."
              rows={1}
            />
            <button
              onClick={() => handleSendMessage()}
              disabled={isLoading || !input.trim()}
              className="w-[45px] h-[45px] bg-purple-500 rounded-full hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-all flex justify-center items-center flex-shrink-0"
            >
              <img
                src="https://cdpi-media.s3.amazonaws.com/Sent.png"
                alt="Send"
                className="w-5 h-5"
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

export default ChatBot;
